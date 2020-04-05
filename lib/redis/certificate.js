#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:certificate');
var rpscb = require('../rpscb');

// usually from nexus1 running certbot with a POST to /maintain/cert/:fqdn
rpscb.on('certificate', function onCertificate(fqdn, cert, chain, key) { // cb(err, ourUrl)
    debug.enabled && debug.apply(0, argsMap(arguments));
    process.emit('certificate', { fqdn: fqdn, cert: cert, chain: chain, key: key });
});
