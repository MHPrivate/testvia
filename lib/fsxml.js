var bodyParser = require('body-parser');
var chain = require('scope-chain');
var closer = require('http-close');
var crypto = require('crypto');
var ejs = require('ejs');
var express = require('express');
var extend = require('node.extend');
var fs = require('fs');
var http = require('http');
var limit = require('./limit');
var main = require.main.exports;
var morgan = require('morgan');
var mysql = require('./mysql');
var os = require('os');
var path = require('path');
var statuses = require('statuses');
var util = require('util');

var app = extend(express(), { skip: true }); // default is for morgan not to log fsapi calls
module.exports= extend(exports, {
    app: app,
    errs: limit(10),
    http: null,
    reqs: limit(50, { index: 0}),
});

app.set('views', path.resolve(__dirname, '../fsxml'));
app.set('view engine', 'xml');
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

app.get('/', function (req, res, next) {
    var query = req.query;
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
    })));
    chain(next, function () {
        if (!(query.section || 'directory').startsWith('directory'))
            return this();
        directory(req, res, this);

    }, function () {
        res.type('text/xml').render(query.section, { viewsdir: app.get('views'), fs: fs, main: main, path: path, query: query, req: req });

    });
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
    })));
    if (Array.isArray(query.section))
        query.section = query.section.shift();
    chain(next, function () {
        if (!(query.section || 'directory').startsWith('directory'))
            return this();
        directory(req, res, this);

    }, function () {
        res.type('text/xml').render(query.section, { viewsdir: app.get('views'), fs: fs, main: main, path: path, query: query, req: req });

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
    var locals = extend(req.locals, { domain: {}, groups: {}, users: {} });
    chain(next, function () {
        this.index = req.index;
        mysql('select * from sipUsers', this);

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
