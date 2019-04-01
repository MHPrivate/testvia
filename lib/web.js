#! /usr/bin/env node-strict
require('./running'); // generates _process_ 'running' & 'terminate' events
var app = require('./app');
var chain = require('scope-chain');
var closer = require('http-close');
var extend = require('node.extend');
var http = require('http');
var https = require('https');
var main = require.main.exports;
var mesh = require('./mesh');
var mysql = require('./mysql');
var tls = require('tls');
var url = require('url');
var x509 = require('x509.js');

var web = module.exports = exports;

process.on('certificate', function onCertificate(dict) { // { fqdn, cert, chain, key }
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
    web.https = https.createServer(main.cache.tls, app).listen(main.setup.https, function () {
        closer({ timeout: 2000 }, this); // intercepts close() - closes any keep-alive browser connections
        mesh(this); // returns _undefined_
        process.once('terminate', function _https() { this.close() }.bind(this)); // invoke prevailing close()
    });
});

process.once('running', function () { // activate port 80 redirection if we are servicing port 443
    if (main.setup.https !== 443)
        return;
    web.http = http.createServer(function (req, res) {
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
    var re = /^[^\.]*/;
    extend(main.cache, {
        snis: {},
        tls: {
            ciphers: process.stdin.isTTY && 'ALL:!ADH:!EXPORT56:RC4+RSA:+HIGH:+MEDIUM:+LOW:+SSLv2:+EXP:!ECDH:!DH', // allow for Wireshark inspection
            SNICallback: function (hostname, cb) {
                var ctx = main.cache.snis[hostname] || main.cache.snis[hostname.replace(re, '*')];
                ctx || console.log('SNICallback:', hostname);
                cb(null, ctx);
            },
        },
    });
    
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
