#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:proxy2');
var mesh = require('../mesh');
var rpscb = require('../rpscb');

rpscb.on('proxy2', function onProxy2(larcId, data, force, cb) { // { appUrl, sipUrl, secret }, force, cb(err, ourUrl) - cb not passed to larc
    debug.enabled && debug.apply(0, argsMap(arguments));
    var cb = arguments[arguments.length - 1];
    if (typeof cb !== 'function')
        return;
    var args = Array.from(arguments).slice(1);
    for (var l in mesh.lsnrs)
        for (var c in mesh.lsnrs[l].mesh.clients)
            if ((mesh.lsnrs[l].mesh.clients[c].locals.access || {}).larcId === larcId)
                return mesh.lsnrs[l].mesh.clients[c].emit.apply(mesh.lsnrs[l].mesh.clients[c], ['proxy'].concat(args)) && cb(null, mesh.lsnrs[l].mesh.url);
    cb();
});
