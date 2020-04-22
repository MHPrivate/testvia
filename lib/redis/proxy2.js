#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:proxy2');
var main = require.main.exports;
var rpscb = require('../rpscb');

rpscb.on('proxy2', function onProxy2(larcId, data, force, cb) { // { appUrl, sipUrl, secret }, force, cb(err, ourUrl) - cb not passed to larc
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

    sios[0].emit.apply(sios[0], ['proxy'].concat(Array.from(arguments).slice(1, -1))); // remove larcId & cb
    cb(null, main.identity);
});
