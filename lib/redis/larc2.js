#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:larc2');
var main = require.main.exports;
var rpscb = require('../rpscb');

rpscb.on('larc2', function onLarc2(larcId, event /* , ..., cb */) { // cb(err, ...)
    debug.enabled && debug.apply(0, argsMap(arguments));
    var cb = arguments[arguments.length - 1];
    if (typeof cb !== 'function')
        return;

    var sios;
    process.emit('sios', sios = [], function (sio) {
        return sio && sio.locals && sio.locals.access && sio.locals.access.larcId === larcId;
    });
    if (!sios.length) // larcId not found
        return cb();

    if (typeof event === 'string') // find2
        return sios[0].emit.apply(sios[0], Array.from(arguments).slice(1)); // remove larcId

    cb(null, main.identity);
});
