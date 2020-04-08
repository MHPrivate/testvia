#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:server2');
var main = require.main.exports;
var rpscb = require('../rpscb');

rpscb.on('server2', function onServers(cb) { // cb(err, ourUrl)
    debug.enabled && debug.apply(0, argsMap(arguments));
    if (typeof cb !== 'function')
        return;
    cb(null, main.identity);
});
