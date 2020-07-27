#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var debug = require('debug')('mesh:scabs');
var events = require('events');
var jsonerr = require('../jsonerr');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mosh = require('../mosh');
var mysql = require('../mysql');
var os = require('os');
var setFunctionName = require('../name-function');
var trk = require('../socket.io-track'); // trk(ms, soc, cb)

var debugX = debug.extend('extra');
module.exports = Object.assign(exports, {
    callbackMs: null, // 500
    clients: {}, // { $scabId => soc }
    fetch: fetch, // fetch(sid, cb) - fetch a session
    flush: flush, // flush(sid, cb) - flush a session
    handlers: { // _this_ is ioSocket, client-side has no _server_ atribute AND server-side has no _close_ method
        established: function onScabsEstablished() { // faked by exports() - scab connection established
            debug.enabled && debug.apply(null, [this.locals.access.scabId, 'onScabsEstablished:'].concat(argsMap(arguments)));
            exports.clients['$' + this.locals.access.scabId] = this;
        },
        disconnecting: function onScabsDisconnecting(reason) { // scab disconnect
            debug.enabled && debug.apply(null, [this.locals.access.scabId, 'onScabsDisconnecting:'].concat(argsMap(arguments)));
            for (var key in exports.sessions)
                if (exports.sessions[key] === this.locals.access.scabId)
                    delete exports.sessions[key];
            delete exports.clients['$' + this.locals.access.scabId];
        },
        //heartbeat: function onHeartbeat() { // client heartbeat
        //    debug.enabled && debug.apply(null, [this.locals.access.scabId, 'onScabsHeartbeat:'].concat(argsMap(arguments)));
        //},
        log: function onScabsLog(data) {
            console.log.apply(null, [this.locals.access.scabId, 'mesh:scabs:log'].concat(argsMap(arguments)));
        },
        request: function onScabsRequest(request, cb) { // { method: 'get|post|put|patch|delete', path, sid, ... }, cb(err, { ... }) } - request from 'master'
            var scabId = this.locals.access.scabId;
            debugX.enabled && debugX.apply(null, ['--- mesh:scabs:request', scabId].concat(argsMap(arguments)));
            var requestCb = typeof cb === 'function' && function (err) {
                debugX.enabled && debugX.apply(null, ['--- mesh:scabs:requestCb', scabId].concat(argsMap(arguments)));
                err ? cb(jsonerr(err)) : cb.apply(null, arguments);
            };
            var event = 'scabs' + request.method.charAt(0).toUpperCase() + request.method.slice(1) + (request.sid ? 'Member' : 'Collection');
            try {
                process.emit(event, this.locals.access.scabId, request, requestCb) || requestCb(new Error('scabs: ' + request.method + ' - not implemented ' + event));
            } catch (ex) {
                requestCb ? requestCb(ex) : console.log('onScabsRequest:', ex);
            }
        },
    },
    sessions: {}, // { $origin$unique => post-auction ? scabId : {nowip,timeout} }
});

function exports(done) { // _this_ is the ioSocket
    if (typeof done !== 'function')
        throw new Error('method expects callback argument');
    debug(this.locals.access.scabId, 'setup:');

    for (var event in exports.handlers)
        this.on(event, exports.handlers[event]);
    events.prototype.emit.call(this, 'established'); // signal as established (ioServer normal)
    done();
}

// create from a scaber to register session
process.on('scabsPostMember', function onScabsPostMember(scabId, create, cb) { // scabId, { method: 'post', sid }, cb(err, ...)
    debugX.apply(null, ['05< mesh:scabs:create'].concat(argsMap(arguments)));
    var createCb = exports.sessions[create.sid]; // only present if session already registered
    var err = { name: 'Exists', message: 'create rejected' };
    if (!create.sid || typeof createCb === 'number') { // missing sid OR aready assigned
        debugX('09> mesh:scabs:createCb', scabId, Error.prototype.toString.call(err));
        return cb(err); // rejection response to scaber
    }

    exports.sessions[create.sid] = scabId;
    var message = {};
    debugX('07> mesh:scabs:createCb', scabId, null, JSON.stringify(message));
    cb(null, message); // acceptance response to scaber

    if (typeof createCb === 'function')
        createCb(null, scabId);
});

// instruction from scaber to flush a session
process.on('scabsDeleteMember', function onScabsDeleteMember(scabId, expire, cb) { // scabId, { method: 'delete', sid }, cb(err, {})
    debugX.apply(null, ['??< mesh:scabs:expire'].concat(argsMap(arguments)));
    var err = null, reply = {};
    if ((exports.sessions[expire.sid] || scabId) !== scabId)
        err = { name: 'Error', message: 'expire for ' + expire.sid + ' expected from ' + exports.sessions[expire.sid] + ' not ' + scabId };
    else
        delete exports.sessions[expire.sid];
    debugX('??> mesh:scabs:expireCb', err ? Error.prototype.toString.call(err) : JSON.stringify(reply));
    cb(err, reply);
});

function flush(sid, cb) {
    debugX.apply(null, ['>?? mesh:scabs:flush'].concat(argsMap(arguments)));
    var flushCb = function (err) {
        debugX.apply(null, ['<?? mesh:scabs:flushCb'].concat(argsMap(arguments)));
        cb && (cb.apply(this, arguments));
    };
    var scabId = exports.sessions[sid], client = exports.clients['$' + scabId];
    if (!scabId || !client)
        return flushCb(new Error('invalid session - ' + (scabId ? scabId : sid)));
    var flush = { method: 'delete', sid: sid };
    debugX('??> mesh:scabs:flush', scabId, JSON.stringify(flush));
    client.emit('request', flush, trk(exports.callbackMs || 500, client, flushCb));
}

function fetch(sid, cb) {
    debugX.apply(null, ['>?? mesh:scabs:fetch'].concat(argsMap(arguments)));
    var fetchCb = function (err) {
        debugX.apply(null, ['<?? mesh:scabs:fetchCb'].concat(argsMap(arguments)));
        cb && (cb.apply(this, arguments));
    };
    var scabId = exports.sessions[sid], client = exports.clients['$' + scabId];
    if (!scabId || !client)
        return fetchCb(new Error('invalid session - ' + (scabId ? scabId : sid)));
    var fetch = { method: 'get', sid: sid };
    debugX('??> mesh:scabs:fetch', scabId, JSON.stringify(fetch));
    client.emit('request', fetch, trk(exports.callbackMs || 500, client, fetchCb));
}

process.on('scabsPostCollection', function onScabsPostCollection(scabId, sessions) { // scabId, { method: 'post', sids: [sid, ...] }
    debugX.apply(null, ['--< mesh:scabs:sessions', scabId].concat(argsMap(arguments)));
    for (var i in sessions.sids)
        exports.sessions[sessions.sids[i]] = scabId;
});
