#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var debug = require('debug')('redis:mosh2');
var mesh = require('../mesh');
var mosh = require('../mosh');
var os = require('os');
var rpscb = require('../rpscb');

rpscb.on('mosh2', function onMosh2(larcId, cb) { // cb(err, host, port, secret)
    debug.enabled && debug.apply(0, argsMap(arguments));
    if (typeof cb !== 'function')
        return;
    for (var l in mesh.lsnrs)
        for (var c in mesh.lsnrs[l].mesh.clients)
            if ((mesh.lsnrs[l].mesh.clients[c].locals.access || {}).larcId === larcId)
                return chain(cb, function () {
                    mosh.larc(mesh.lsnrs[l].mesh.clients[c].locals.ipv6, this);

                }, function (port) {
                    this.port = port;
                    mesh.lsnrs[l].mesh.clients[c].emit('mosh2', { host: os.hostname(), port: port }, this);

                }, function (secret) {
                    secret ? this(null, os.hostname(), this.port, secret) : this();

                });
    cb(); // larcId not found
});
