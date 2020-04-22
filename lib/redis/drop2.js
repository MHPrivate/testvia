#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:drop2');
var main = require.main.exports;
var rpscb = require('../rpscb');

rpscb.on('drop2', function onDrop2(larcId, cb) { // cb(err, ourUrl)
    debug.enabled && debug.apply(0, argsMap(arguments));
    if (typeof cb !== 'function')
        return;

    var sios;
    process.emit('sios', sios = [], function (sio) {
        return sio && sio.locals && sio.locals.access && sio.locals.access.larcId === larcId;
    });
    if (!sios.length) // larcId not found
        return cb();

    sios.forEach(function (sio, idx, arr) {
        sio.disconnect();
    });
    cb(null, main.identity);
});
