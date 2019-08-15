#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var debug = require('debug')('mesh:scabs');
var events = require('events');
var extend = require('node.extend');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mosh = require('../mosh');
var mysql = require('../mysql');
var os = require('os');
var setFunctionName = require('../name-function');

module.exports = extend(exports, {
    //emit: emit,
    handlers: { // _this_ is ioSocket, client-side has no _server_ atribute AND server-side has no _close_ method
        established: function onEstablished() { // faked by exports() - scab connection established
            debug.enabled && debug.bind(null, [this.locals.access.scabId, 'onEstablished:'].concat(argsMap(arguments)));
        },
        disconnecting: function onDisconnecting(reason) { // scab disconnect
            debug.enabled && debug.apply(null, [this.locals.access.scabId, 'onDisconnecting:'].concat(argsMap(arguments)));
        },
        heartbeat: function onHeartbeat() { // client heartbeat
            debug.enabled && debug.apply(null, [this.locals.access.scabId, 'onHeartbeat:'].concat(argsMap(arguments)));
        },
        log: function onLog(data) {
            console.log.apply(console, [this.locals.access.scabId, 'mesh:scabs:log'].concat(argsMap(arguments)));
        },
    },
    mesh: null, // will be require('.') once running - used by:
});

process.once('running', function () { // delayed _require_ is necessary as it loads us
    exports.mesh = require('.');
});

function exports(done) { // _this_ is the ioSocket
    if (typeof done !== 'function')
        throw new Error('method expects callback argument');
    debug('setup:', this.locals.access.scabId);

    var soc = this;
    Object.keys(exports.handlers).forEach(function (handler, idx, arr) {
        soc.on(handler, this[handler]);
    }, exports.handlers);
    events.prototype.emit.call(soc, 'established'); // signal as established (ioServer normal)
    done();
}

//function emit(event /* , ... */) {
//    for (var idx in this.mesh.lsnrs) { // foreach listener socket
//        var lsnr = this.mesh.lsnrs[idx];
//        for (var url in lsnr.mesh.peers) // foreach peer of the listener socket
//            lsnr.mesh.peers[url].emit.apply(lsnr.mesh.peers[url], arguments);
//    }
//}
