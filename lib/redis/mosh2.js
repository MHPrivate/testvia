#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var debug = require('debug')('redis:mosh2');
var main = require.main.exports;
var mosh = require('../mosh');
var os = require('os');
var rpscb = require('../rpscb');

rpscb.on('mosh2', function onMosh2(larcId, cb) { // cb(err, host, port, secret)
    debug.enabled && debug.apply(0, argsMap(arguments));
    if (typeof cb !== 'function')
        return;

    var sios;
    process.emit('sios', sios = [], function (sio) {
        return sio && sio.locals && sio.locals.access && sio.locals.access.larcId === larcId;
    });
    if (!sios.length) // larcId not found
        return cb();

    chain(cb, function () {
        mosh.larc(sios[0].locals.ipv6, this);

    }, function (port) {
        this.port = port;
        sios[0].emit('mosh2', { host: os.hostname(), port: port }, this);

    }, function (secret) {
        secret ? this(null, os.hostname(), this.port, secret) : this();

    });
});
