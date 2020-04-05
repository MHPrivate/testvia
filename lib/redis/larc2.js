#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:larc2');
var mesh = require('../mesh');
var rpscb = require('../rpscb');

rpscb.on('larc2', function onLarc2(larcId, event /* , ..., cb */) { // cb(err, ...)
    debug.enabled && debug.apply(0, argsMap(arguments));
    var cb = arguments[arguments.length - 1];
    if (typeof cb !== 'function')
        return;
    for (var l in mesh.lsnrs)
        for (var c in mesh.lsnrs[l].mesh.clients)
            if ((mesh.lsnrs[l].mesh.clients[c].locals.access || {}).larcId !== larcId)
                continue;
            else if (!event) // find2
                return cb(null, mesh.lsnrs[l].mesh.url);
            else
                return mesh.lsnrs[l].mesh.clients[c].emit.apply(mesh.lsnrs[l].mesh.clients[c], Array.from(arguments).slice(1));
    cb(); // larcId not found
});
