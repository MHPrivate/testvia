#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:mosh');
var rpscb = require('../rpscb');

// from nexus/code POST to /v1/mosh from a larc
rpscb.on('mosh', function onMosh(host, port, secret) {
    debug.enabled && debug.apply(0, argsMap(arguments));
    process.emit('mosh', port, secret, host);
});
