#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cio = require('socket.io-client');
var debug = require('debug')('webio');
var jsonerr = require('../jsonerr');
var jwt = require('jsonwebtoken');
var main = require.main.exports;

module.exports = Object.assign(exports, {
    close: function close() { // _this_ is _exports
        if (!this._callbacks) // only present when open
            return;
        var soc = this.__proto__;
        cio.Manager.prototype.emit.call(soc, 'closing'); // soc._callbacks['$closing']
        soc.close.apply(soc, arguments);
    },
    handlers: {
        closing: function onWebioClosing() {
            debug.enabled && debug.apply(null, ['onWebioClosing:'].concat(argsMap(arguments)));
            Object.setPrototypeOf(exports, {}.__proto__); // restore default __proto__
        },
        connect: function onWebioConnect() {
            debug.enabled && debug.apply(null, ['onWebioConnect:'].concat(argsMap(arguments)));
            var access = { exp: Date.now() / 1000 + 5, scabId: process.pid };
            this.emit('accessJwt', jwt.sign(access, main.secrets.peerSecret, { algorithm: 'HS256' }));
            process.emit('webioConnect');
        },
        connect_error: function onWebioConnectError(err) { // only client-side
            debug('onWebioConnectError:', err.toString());
        },
        disconnect: function onWebioDisconnect(reason) {
            debug.enabled && debug.apply(null, ['onWebioDisconnect:'].concat(argsMap(arguments)));
        },
        disconnecting: function onWebioDisconnecting(reason) {
            debug.enabled && debug.apply(null, ['onWebioDisconnecting:'].concat(argsMap(arguments)));
        },
        log: function onWebioLog(log) {
            debug.enabled
                ? debug.apply(null, ['onWebioLog:'].concat(argsMap(arguments)))
                : console.log.apply(null, ['webio:log:'].concat(argsMap(arguments)));
        },
        request: function onWebioRequest(request, cb) { // { method: 'get|post|put|patch|delete', path, sid, ... }, cb(err, { ... }) } - request from 'websvc'
            debug.enabled && debug.apply(0, ['--- websvc:request'].concat(argsMap(arguments)));
            var requestCb = typeof cb === 'function' && function (err) {
                debug.enabled && debug.apply(0, ['--- websvc:requestCb'].concat(argsMap(arguments)));
                err ? cb(jsonerr(err)) : cb.apply(null, arguments);
            };
            try {
                process.emit('webio', request, requestCb) || requestCb(new Error('webio: not implemented'));
            } catch (ex) {
                requestCb ? requestCb(ex) : console.log('onWebioRequest:', ex);
            }
        },
    },
    emit: function emit(name, message, cb) {
        debug.enabled && debug.apply(0, ['--- websvc:emit'].concat(argsMap(arguments)));
        if (!this._callbacks) // only present when open
            return cb(new Error('websvc unavailable'));
        this.__proto__.emit(name, message, cb && function emitCb(err) {
            debug.enabled && debug.apply(0, ['--- websvc:emitCb'].concat(argsMap(arguments)));
            cb.apply(this, arguments);
        });
    },
});

process.running.then(function webio() {
    main.state.scalimit = +process.env.SCA_LIMIT;
    process.once('terminate', function _webio() {
        exports.close();
    });

    var soc = cio('https://localhost.' + main.secrets.fqdn + ':' + (process.env.PORT || '443'));
    Object.setPrototypeOf(exports, soc);

    for (var event in exports.handlers)
        soc.on(event, exports.handlers[event]);
});
