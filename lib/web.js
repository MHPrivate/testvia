#!/usr/bin / env node - strict
require('./running'); // generates _process_ 'running' & 'terminate' events
var bodyParser = require('body-parser');
var chain = require('scope-chain');
var closer = require('http-close');
var cookieParser = require('cookie-parser');
var express = require('express');
var extend = require('node.extend');
var http = require('http');
var https = require('https');
var main = require.main.exports;
var mesh = require('./mesh');
var morgan = require('morgan');
var mysql = require('./mysql');
var path = require('path');
var statuses = require('statuses');
var tls = require('tls');
var url = require('url');
var util = require('util');
var x509 = require('x509.js');

var app = express();
var secrets = [];
module.exports = extend(exports, {
    app: app,
    errs: extend([], { limit: 10 }),
    http: null,
    https: null,
    reqs: extend([], { limit: 10, index: 0 }),
});

// view engine setup
app.set('views', path.resolve(__dirname, '../views'));
app.set('view engine', 'ejs');
app.engine('html', require('ejs').renderFile);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(cookieParser(secrets));
app.use(morgan('combined'));
app.use(function (req, res, next) {
    req.index = ('000' + exports.reqs.index++).slice(-3);
    (exports.reqs.unshift(req) > exports.reqs.limit) && exports.reqs.limit && (exports.reqs.length = exports.reqs.limit);
    req.locals = req.locals || {}; // general purpose stash for request processing
    next();
});

var locals = require('./locals');
app.use(locals); // index, locals, jwt(s)
app.use(require('../routes')); // individually secured as necessary
app.use(locals.user(express.static(__dirname + '/../static/secure'))); // sanctioned users only
app.use(locals.user(express.static('/tmp/appello'))); // sanctioned users only
app.use(express.static(__dirname + '/../static/public')); // open to the masses

// catch 404 and forward to error handler
app.use(function (req, res, next) {
    next(extend(new Error(statuses[404]), { status: 404 }));
});

// error handler
app.use(function (err, req, res, next) {
    err.status = err.status || 500;
    if (err.status !== 404) {
        console.error(err.stack || err);
        (exports.errs.unshift(err) > exports.errs.limit) && (exports.errs.length = exports.errs.limit);
        err.req = req;
    }

    res.status(err.status);
    res.format({
        'text/plain': function () {
            res.send((process.stdin.isTTY ? util.inspect(err) : statuses[err.status]) + '\n');
        },

        'text/html': function () {
            res.render('error.html', {
                req: req,
                main: main,
                status: err.status,
                message: err.message,
                error: err.status !== 404 && process.stdin.isTTY && err,
            });
        },

        'application/json': function () {
            res.json({ error: statuses[err.status], status: err.status });
        },

        'default': function () {
            // log the request and respond with 406
            res.status(406).send('Not Acceptable');
        }
    });
});

process.on('certificate', function onCertificateWeb(dict) { // { fqdn, cert, chain, key }
    if (dict.fqdn !== main.secrets.fqdn)
        return;
    extend(main.cache.tls, dict);
    var ctx = tls.createSecureContext({ cert: dict.cert + (dict.chain || ''), key: dict.key });
    extend(ctx, x509.parseCert(dict.cert));
    ctx.altNames.concat(ctx.subject.commonName).forEach(function (name) {
        main.cache.snis[name] = ctx;
    });
});

process.once('certificate', function () { // setup the https service
    var re = /^[^\.]*/;
    exports.https = https.createServer({
        ciphers: process.stdin.isTTY && 'ALL:!ADH:!EXPORT56:RC4+RSA:+HIGH:+MEDIUM:+LOW:+SSLv2:+EXP:!ECDH:!DH', // allow for Wireshark inspection
        SNICallback: function (hostname, cb) {
            var ctx = main.cache.snis[hostname] || main.cache.snis[hostname.replace(re, '*')];
            ctx || console.log('SNICallback:', hostname);
            cb(null, ctx);
        },
    }, app).listen(main.setup.https, function () {
        closer({ timeout: 2000 }, this); // intercepts close() - closes any keep-alive browser connections
        mesh(this); // returns _undefined_
        process.once('terminate', function _https() { this.close() }.bind(this)); // invoke prevailing close()
    });
});

process.once('running', function () { // activate port 80 redirection if we are servicing port 443
    secrets.push(main.secrets.peerSecret); // used by cookie-parser
    if (main.setup.https !== 443)
        return;
    exports.http = http.createServer(function (req, res) {
        if (!req.headers.host)
            res.writeHead(404, { 'Content-Length': 0 });
        else
            res.writeHead(301, {
                'Content-Length': 0,
                Location: extend(url.parse('https://' + req.headers.host + req.url), {
                    host: null, // forces rebuild
                    port: null, // discard the port if any
                }).format(),
            });
        res.end();
    }).listen(80, function () {
        closer({ timeout: 2000 }, this); // intercepts close() - closes any keep-alive browser connections
        process.once('terminate', function _http() { this.close() }.bind(this)); // invoke prevailing close()
    });
});

process.once('mysql', function () { // database is ready - fetch our TLS certificate used by HTTPS:SNICallback
    extend(main.cache, { snis: {}, tls: {} });

    chain(null, function () {
        this.index = 'startup';
        mysql('select f.*,l.chain from fqdns f left join leChains l on f.chainId=l.id where f.fqdn=?', [main.secrets.fqdn], this);

    }, function (fqdns, meta) {
        if (!fqdns.length)
            return;
        var fqdn = fqdns.shift();
        process.emit('certificate', { fqdn: fqdn.fqdn, cert: fqdn.cert, chain: fqdn.chain, key: fqdn.privkey });

    });
});
