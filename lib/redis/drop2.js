#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:drop2');
var mesh = require('../mesh');
var rpscb = require('../rpscb');

rpscb.on('drop2', function onDrop2(larcId, cb) { // cb(err, ourUrl)
    debug.enabled && debug.apply(0, argsMap(arguments));
    if (typeof cb !== 'function')
        return;
    for (var l in mesh.lsnrs)
        for (var c in mesh.lsnrs[l].mesh.clients)
            if ((mesh.lsnrs[l].mesh.clients[c].locals.access || {}).larcId === larcId)
                return mesh.lsnrs[l].mesh.clients[c].disconnect() && cb(null, mesh.lsnrs[l].mesh.url);
    cb(); // larcId not found
});
