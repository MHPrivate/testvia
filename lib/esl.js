#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('esl');
var extend = require('node.extend');
var main = require.main.exports;
var modesl = require('modesl');
var os = require('os');
var setFunctionName = require('./name-function');

var recoverMs = 0; // grows in 1s increments to a hardcoded maximum
var timeout = undefined; // used for lost-connection recovery
module.exports = extend(exports, {
    apiX: null,                             // placeholder for re-packaged modesl method to use callbacks with err first argument
    authX: null,                            // placeholder for re-packaged modesl method to use callbacks with err first argument
    bgapiX: null,                           // placeholder for re-packaged modesl method to use callbacks with err first argument
    executeX: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
    executeAsyncX: null,                    // placeholder for re-packaged modesl method to use callbacks with err first argument
    history: extend([], { limit: 100 }),    // limited history of recent freeswitch events
    messageX: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
    originateX: null,                       // placeholder for re-packaged modesl method to use callbacks with err first argument
    newListener: debug.enabled,             // modesl control flag to activate 'newListener' emits
    parseEvt: parseEvt,                     // method to re-cast evt:headers as a dictionary
    showX: null,                            // placeholder for re-packaged modesl method to use callbacks with err first argument
    subscribeX: null,                       // placeholder for re-packaged modesl method to use callbacks with err first argument
});

process.once('running', start); // establish a freeswitch connection
process.once('terminate', function _esl() {
    timeout = clearTimeout(timeout) || true; // prevents a new call to setTimeout()
    exports.socket && exports.disconnect(); // unsets 'socket' before jobCallbacks
    abortJobs.call(exports);
});

function abortJobs() { // called on socket closure to ensure no callbacks are left hanging
    var cb;
    while (this.cmdCallbackQueue.length) // sendRecv-jobs (sendEvent, filter, filterDelete, events, auth)
        (cb = this.cmdCallbackQueue.shift()) && cb.call(this);
    while (this.apiCallbackQueue.length) // api-jobs
        (cb = this.apiCallbackQueue.shift()) && cb.call(this);
    for (var jobid in this.listenerTree.esl.event.BACKGROUND_JOB) // bgapi-jobs
        this.emit('esl::event::BACKGROUND_JOB::' + jobid);
    for (var uuid in this.listenerTree.esl.event.CHANNEL_EXECUTE_COMPLETE) // bgapi-jobs
        this.emit('esl::event::CHANNEL_EXECUTE_COMPLETE::' + uuid);
}

function start() { // establish a freeswitch connection
    timeout = clearTimeout(timeout);
    exports.socket || chain(function cleanup(err) {
        err && console.log('esl: fail:', err);
    
    }, function () {
        var secrets = main.secrets || { freeswitch: {} };
        Object.setPrototypeOf(exports, new modesl.Connection('localhost', 8021, secrets.freeswitch[os.hostname()] || secrets.freeswitch.default || 'ClueCon', this));
        for (var handler in handlers)
            exports.on(handler, handlers[handler]);

    }, function () {
        recoverMs = 0; // successful connection - reset the 
        exports.__proto__.subscribe('all', this.noerror); // cb(evt, hdrs, body)

    });
};

var handlers = {
    newListener: function (type, handler) { // only functions if exports.newListeners is set
        console.log('esl: newListener:', type);
    },
    error: function onError(err) {
        if ((this.socket || {}).destroyed) { // cleanup if this error destroyed the socket
            this.socket = null;
            abortJobs.call(this);
        }
        switch (err.code) {
            case 'ECONNREFUSED': // log AND initiate connection recovery
            case 'ECONNRESET':
                timeout = timeout || setTimeout(start, recoverMs += (recoverMs < 5000) * 1000);
                console.log('esl: error:', err.message, recoverMs);
                break;
            default: // just log
                console.log('esl: error:', err);
                break;
        }
    },
    'esl::end': function onEslEnd() { // freeswitch clean-shutdown - initiate connection recovery
        timeout = timeout || setTimeout(start, recoverMs += (recoverMs < 5000) * 1000);
        abortJobs.call(this);
    },  
    'esl::**': function onEsl(evt, hdrs, body) { // catch-all event processing (e.g. history)
        parseEvt.apply(this, arguments);
    },
};

function parseEvt(evt) { // transform evt.headers to dictionary "evt = parseEvt.apply(this, arguments);"
    if (evt) {
        evt.event || (evt.event = this && this.event);
        if (evt.headers && !Array.isArray(evt.headers)) // already parsed
            return evt;
    }
    exports.history.push(evt || (evt = { headers: [], event: this && this.event }));
    debug.enabled && debug(evt.headers.length, evt.event);
    var headers = Object.create(evt.headers);
    for (var i = 0; i < evt.headers.length; ++i)
        headers[evt.headers[i].name] = evt.headers[i].value;
    evt.headers = headers;
    if (exports.history.length > exports.history.limit && evt.type === 'HEARTBEAT')
        exports.history.limit && exports.history.splice(0, exports.history.length - exports.history.limit);
    return evt;
}

// re-package modesl methods to expect callbacks with err first arguments
['auth', 'show'].forEach(function (name, idx, arr) {
    var nameX = name + 'X';
    exports[nameX] = setFunctionName(nameX, function (/* ..., */ cb) { // already expects callbacks taking err as a first argument
        return this.__proto__[name].apply(this.__proto__, arguments);
    });
});
['api', 'bgapi', 'execute', 'executeAsync', 'message', 'originate', 'subscribe'].forEach(function (name, idx, arr) {
    var nameX = name + 'X';
    exports[nameX] = setFunctionName(nameX, function (/* ..., */ cb) { // expects callbacks not taking err as a first argument
        var args = Array.from(arguments);
        cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : function () { };
        args.push(function (evt /* , hdrs, body */) {
            if (!evt) // aborted
                return cb(new Error(nameX + 'aborted'));
            parseEvt.apply(this, arguments);
            cb.apply(this, [null].concat(Array.from(arguments)));
        });
        return this.__proto__[name].apply(this.__proto__, args);
    });
});
