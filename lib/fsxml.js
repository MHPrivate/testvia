var bodyParser = require('body-parser');
var chain = require('scope-chain');
var closer = require('http-close');
var crypto = require('crypto');
var ejs = require('ejs');
var express = require('express');
var extend = require('node.extend');
var fs = require('fs');
var http = require('http');
var jwt = require('jsonwebtoken');
var limit = require('./limit');
var main = require.main.exports;
var morgan = require('morgan');
var mysql = require('./mysql');
var os = require('os');
var path = require('path');
var statuses = require('statuses');
var url = require('url');
var util = require('util');

var app = Object.assign(express(), { skip: true }); // default is for morgan not to log fsapi calls
module.exports = Object.assign(exports, {
    app: app,
    errs: limit(10),
    http: null,
    reqs: limit(50, { index: 0 }),
});

app.set('views', path.resolve(__dirname, '../fsxml'));
app.set('view engine', 'xml');
app.set('view options', { openDelimiter: '{', closeDelimiter: '}' });
app.engine('xml', require('ejs').renderFile);
app.use(morgan('combined', { skip: function (req, res) { return req.app.skip } }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(function (req, res, next) {
    req.index = ('000' + exports.reqs.index++).slice(-3);
    limit(exports.reqs, req);
    req.locals = {};
    next();
});

app.post('/', function (req, res, next) {
    var query = req.body;
    console.log(JSON.stringify(extend(null, {
        section: query.section,
        tag_name: query.tag_name || undefined,
        key_value: query.key_value || undefined,
        profile: query.profile,
        sip_profile: query.sip_profile,
        purpose: query.purpose,
        domain: query.domain,
        presence: query.presence,
        action: query.action,
        user: query.user,
        macro_name: query.macro_name,
        lang: query.lang,
        'Caller-Context': query['Caller-Context'],
        'Caller-Destination-Number': query['Caller-Destination-Number'],
        context: query.context,
        to_user: query.to_user,
        _expedite: query['variable_sip_h_X-AppelloExpedite'] && query['variable_sip_h_X-AppelloExpedite'].slice(0,8),
    })));
    if (Array.isArray(query.section))
        query.section = query.section.shift();
    var locals = Object.assign(req.locals, {
        appelloExpedite: undefined,
        cone: undefined,
        dialPrefix: undefined,
        expedite: undefined, // {byps,dest,name,numb,domn}
        fs: fs,
        main: main,
        path: path,
        query: query,
        req: req,
        viewsdir: app.get('views'),
    });
    next.index = req.index;
    chain(next, function () {
        expedite(req, this);

    }, function () {
        if (locals.expedite) // valid expedite header - skip further database lookup
            return res.type('text/xml').render(query.section, locals);
        (query.section || 'directory').startsWith('directory') ? directory(req, res, this) : this();

    }, function () {
        if (!query['Caller-Destination-Number'])
            return res.type('text/xml').render(query.section, locals);
        mysql('select * from sipUsers where name="registration" and user=substring(?,1,length(user)) order by length(user) desc', [query['Caller-Destination-Number']], this);

    }, function (sipUsers, meta) {
        locals.sipUsers = sipUsers;
        locals.utc = req._startTime / 1000;
        sipUsers.some(function (sipUser, idx, arr) {
            sipUser.value = JSON.parse(sipUser.value);
            if (locals.utc < sipUser.value.expires)
                return Object.assign(locals, {
                    dialPrefix: sipUser.user,
                    cone: sipUser.value.hostname,
                    appelloExpedite: jwt.sign({
                        byps: false, // bypass_media - can do something clever with this to improve the media path
                        dest: query['Caller-Destination-Number'],
                        name: undefined,
                        numb: undefined,
                        prfx: sipUser.user,
                    }, main.cache.tls.key, { algorithm: 'HS256' }),
                });
        });
        res.type('text/xml').render(query.section, locals);

    });
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handler
app.use(function (err, req, res, next) {
    err.status = err.status || 500;
    if (err.status !== 404) {
        console.error(err.stack || err);
        limit(exports.errs, err);
        err.req = req;
    }

    res.type('text/xml').send([
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        '<document type="freeswitch/xml" description="error">',
        '  <section name="result">',
        '    <result status="not found"/>',
        '  </section>',
        '</document>',
    ].join('\n'));
});

var ports = { 443: 8020, 8443: 8018 };
process.running.then(function () {
    if (!ports[main.setup.https])
        return;
    // open HTTP if configured TLS port is 443
    exports.http = http.createServer(app).listen(ports[main.setup.https], function () {
        closer({ timeout: 2000 }, this); // intercepts this.close() - so must come first
        process.once('terminate', function _fsxml() { // calls intercepted this.close() - so must come second
            this.close();
        }.bind(this));
    });
});

function directory(req, res, next) {
    var realm = main.secrets.fqdn, a1;
    var locals = Object.assign(req.locals, { domain: {}, groups: {}, users: {} });
    chain(next, function () {
        this.index = req.index;
        mysql('select * from sipUsers where type in ("group","param","variable")', this);

    }, function (users, meta) {
        for (var i in users) {
            var row = users[i], type, group, user;
            switch (row.scope) {
                case 'domain':
                    type = locals.domain[row.type] || (locals.domain[row.type] = {});
                    type[row.name] = row.value;
                    break;

                case 'group':
                    group = locals.groups[row.user] || (locals.groups[row.user] = {});
                    type = group[row.type] || (group[row.type] = {});
                    type[row.name] = row.value;
                    break;

                case 'user':
                    user = locals.users[row.user] || (locals.users[row.user] = {});
                    if (row.type === 'group') {
                        group = locals.groups[row.name] || (locals.groups[row.name] = {});
                        (group.users || (group.users = {}))[row.user] = true;
                    } else {
                        type = user[row.type] || (user[row.type] = {});
                        if (row.name !== 'password') {
                            type[row.name] = row.value;
                        } else {
                            a1 = [row.user, realm, row.value].join(':');
                            type['a1-hash'] = crypto.createHash('md5').update(a1).digest('hex');
                        }
                    }
                    break;
            }
        }
        this();

    });
}

function expedite(req, cb) {
    var locals = req.locals, query = locals.query;
    if (query.section !== 'dialplan'
        || !(query.variable_sofia_profile_name || '').includes('external')
        || (query['Caller-Context'] || '') !== 'public'
        || !(query['variable_sip_h_X-AppelloExpedite'] || '').startsWith('eyJhbGci')) // base64('{"alg"')
        return cb();
    chain(cb, function () {
        // symetrically signing with the current tls.key yields a shorter jwt
        jwt.verify(query['variable_sip_h_X-AppelloExpedite'], main.cache.tls.key, { algorithms: ['HS256'] }, this.noerror);

    }, function (err, json) { // err, {byps, dest, name, numb, prfx}
        locals.expedite = json;
        this();

    });
}

/// fsapi calls
// {section: "configuration", tag_name:"configuration", key_value:"cdr_csv.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"sofia.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"sofia.conf", profile:"external-ipv6"}
// {section: "configuration", tag_name:"configuration", key_value:"sofia.conf", profile:"external"}
// {section: "configuration", tag_name:"configuration", key_value:"sofia.conf", profile:"internal-ipv6"}
// {section: "configuration", tag_name:"configuration", key_value:"sofia.conf", profile:"internal"}
// {section: "configuration", tag_name:"configuration", key_value:"conference.conf", presence:"true"}
// {section: "configuration", tag_name:"configuration", key_value:"db.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"fifo.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"hash.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"voicemail.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"voicemail.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"httapi.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"spandsp.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"local_stream.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"post_load_modules.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"acl.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"event_socket.conf"}
// {section: "configuration", tag_name:"configuration", key_value:"post_load_switch.conf"}
// {section: "directory", profile:"external", purpose:"gateways"}
// {section: "directory", profile:"internal", purpose:"gateways"}
// {section: "directory", tag_name:"domain", key_value:"192.168.0.11", purpose:"network-list", domain :"192.168.0.11"}
// {section: "directory", tag_name:"domain", key_value:"192.168.0.11", domain:"192.168.0.11", action:"sip_auth", user:"1000"}
// {section: "directory", tag_name:"domain", key_value:"192.168.0.11", domain:"192.168.0.11", action:"message-count", user:"1000"}
// {section: "directory", tag_name:"domain", key_value:"192.168.0.11", domain:"192.168.0.11", action:"sip_auth", user:"1000"}
// {section: "dialplan", "Caller-Context":"default", "Caller-Destination-Number":"9172"}
// {section: "languages", macro_name:"say_app", lang:"en", "Caller-Context":"default", "Caller-Destination-Number":"9172"}
