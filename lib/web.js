#! /usr/bin/env node-strict
require('./running'); // generates _process_ 'running' & 'terminate' events
var app = require('./app');
var chain = require('scope-chain');
var closer = require('http-close');
var extend = require('node.extend');
var http = require('http');
var https = require('https');
var main = process.mainModule.exports;
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

process.once('running', function () { // setup the https service
    var re = /^[^\.]*/;
    extend(main.cache, {
        snis: {},
        tls: {
            cert: [ // self-signed localhost - 1day - rsa:512 - default (not sensitive)
                '-----BEGIN CERTIFICATE-----',
                'MIIBizCCATWgAwIBAgIJAJWbzl93h3tdMA0GCSqGSIb3DQEBCwUAMCExCzAJBgNV',
                'BAYTAlhYMRIwEAYDVQQDDAlsb2NhbGhvc3QwHhcNMTgwMzA4MDg0NTU4WhcNMTgw',
                'MzA5MDg0NTU4WjAhMQswCQYDVQQGEwJYWDESMBAGA1UEAwwJbG9jYWxob3N0MFww',
                'DQYJKoZIhvcNAQEBBQADSwAwSAJBAL2DFkh++ouWrqaE24P5ZW4uL7wmCvn/XKSE',
                'EtiIs4yLYoURLPiYREr9azTm9d9V3lPDHcRSiyr5zY/YHYz+C5MCAwEAAaNQME4w',
                'HQYDVR0OBBYEFPhHBlPdp9oOFzIOzGDAnE6L+KEtMB8GA1UdIwQYMBaAFPhHBlPd',
                'p9oOFzIOzGDAnE6L+KEtMAwGA1UdEwQFMAMBAf8wDQYJKoZIhvcNAQELBQADQQBe',
                '73A7XyC3iP9MWk684G/obAWw0Ho7iyv2/tcV6Gfp31uL/LnCuHuTVzDKJ9r6PXFt',
                '98PFCPF2iHZ4uYlELqEl',
                '-----END CERTIFICATE-----',
            ].join('\n'),
            ciphers: process.stdin.isTTY && 'ALL:!ADH:!EXPORT56:RC4+RSA:+HIGH:+MEDIUM:+LOW:+SSLv2:+EXP:!ECDH:!DH', // allow for Wireshark inspection
            fqdn: 'localhost',
            key: [ // self-signed localhost - 1day - rsa:512 - default (not sensitive)
                '-----BEGIN PRIVATE KEY-----',
                'MIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEAvYMWSH76i5aupoTb',
                'g/llbi4vvCYK+f9cpIQS2IizjItihREs+JhESv1rNOb131XeU8MdxFKLKvnNj9gd',
                'jP4LkwIDAQABAkEAsNi0IaDE4yARCPlv8572xTO6feQuWA6xgCBzibc/fgU0av6Y',
                'CGmQvrX0jJhLBbNUIjMAl6vXl0Mo1/+mZgUzMQIhAOn62irvLHY/ZtM7mzHsS56K',
                'oTu/EBBDRBPAZYsf1oNZAiEAz1jlX50XKQAlJ0POde+W32GPEv9cIFVVH0B+0HA6',
                'hMsCIQDXbsctvOYdQic02q78emrt4Qqvbi4mKyklXoKgZIIokQIhAMcpljj/BU4G',
                'q6lJgjjaB8tNREZ1LiKIlJjONIE2K599AiBueSJ6hs0z7l8fsIKBxNMaRnG3mGcj',
                'kM/yVWkqK/oxnw==',
                '-----END PRIVATE KEY-----',
            ].join('\n'),
            SNICallback: function (hostname, cb) {
                var ctx = main.cache.snis[hostname] || main.cache.snis[hostname.replace(re, '*')];
                ctx || console.log('SNICallback:', hostname);
                cb(null, ctx);
            },
        },
    });

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
