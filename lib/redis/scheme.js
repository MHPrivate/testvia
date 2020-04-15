#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var debug = require('debug')('redis:scheme');
var main = require.main.exports;
var rpscb = require('../rpscb');

module.exports = exports; // schemeId => { [soc-bound-emit] soc }

process.on('larcDropped', function onLarcDropped(ipstr, soc) { // soc absent for heartbeats
    debug.enabled && debug.apply(0, ['larcDropped:'].concat(argsMap(arguments)));
    // soc.locals.access = {larcId,name,schemeId,dialPrefix,iat,exp}
    if (!soc || !soc.locals || !soc.locals.access || !soc.locals.access.schemeId)
        return;

    var existingEmit = exports[soc.locals.access.schemeId] || {};
    if (existingEmit.soc !== soc) // not master
        return;

    var scheme = 'scheme:' + soc.locals.access.schemeId;
    existingEmit.soc && rpscb.removeListener(scheme, existingEmit);
    delete exports[soc.locals.access.schemeId];
});

process.on('larcMaster', function onLarcMaster(master, soc) {
    debug.enabled && debug.apply(0, ['larcMaster:'].concat(argsMap(arguments)));
    // soc.locals.access = {larcId,name,schemeId,dialPrefix,iat,exp}
    if (!soc || !soc.locals || !soc.locals.access || !soc.locals.access.schemeId)
        return;

    var existingEmit = exports[soc.locals.access.schemeId] || {};
    if (existingEmit.soc === soc === master) // no change: (existing.soc == this.soc && master) OR (existing.soc != this.soc && !master)
        return;

    var scheme = 'scheme:' + soc.locals.access.schemeId;
    existingEmit.soc && rpscb.removeListener(scheme, existingEmit);

    if (!master)
        return delete exports[soc.locals.access.schemeId];
    rpscb.addListener(scheme, exports[soc.locals.access.schemeId] = Object.assign(larcEmit.bind(soc), { soc: soc }));
});

function larcEmit(event /* , ... */) {
    debug.enabled && debug.apply(0, ['larcEmit:'].concat(Array.from(arguments)));
    this.emit.apply(this, arguments);
}