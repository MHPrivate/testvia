#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cluster = require('cluster');
var debug = require('debug')('worker');
var esl = require('../esl');
var events = require('events');
var limit = require('../limit');
var main = require.main.exports;
var modesl = require('modesl');

main.cache.sessions = limit(10)

var worker = cluster.worker; //  **** BE CAREFUL **** - this is the prototype of this module's _exports_ object, not the actual _exports_ object
module.exports = Object.defineProperties(Object.assign(Object.setPrototypeOf(exports, cluster.worker), { // worker: disconnect, message
    debug: require('debug'),
    handle: undefined, // dummy passed to all messaging functions
    isCommunicatorUser: function isCommunicatorUser(user) {
        return user in main.config.Communicators;
    },
    retired: new Date, // start life retired, to be activated by our own Scaber-Started event
    routes: {}, // { origin => Session, unique => session, <Channel-Call-UUID> ==> session, ... }
    sendCb: function sendCb(message, handle, cb) {
        sendCb.ids || (sendCb.ids = 0);
        message = Object.assign({ ack: ++sendCb.ids }, message); // local clone
        sendCb[message.ack] = function _sendCb() {
            delete sendCb[message.ack] && cb.apply(this, arguments);
        };
        this.__proto__.send(message, handle, function (err) {
            err && delete sendCb[message.ack] && console.log('worker:sendCb:', err);
        });
    },
    sent: function sent(txt) { // callback factory helper for calls to worker.send(message, handle, cb)
        return function (err) { err && console.log(txt + ':', err) };
    },
    sessions: {}, // { $origin$unique => Session }
    started: new Date(Date.now() - process.uptime() * 1000), // used to establish worker supremacy
}), {
    debug: { enumerable: false },
    handle: { enumerable: false, writable: false },
    sendCb: { enumerable: false },
    sent: { enumerable: false },
});

worker.on('disconnect', function onWorkerDisconnect() {
    debug.enabled && debug.apply(0, [process.pid, 'workerDisconnect#' + worker.id].concat(argsMap(arguments)));
});

worker.on('message', function onWorkerMessage(message, handle) { // _this_ is worker - { event, sid, ... } OR { ack, ?err, ?code }
    debug.enabled && debug.apply(0, [process.pid, '--- worker:message#' + this.id].concat(argsMap(arguments)));
    var event = [message.event], ack = message.ack, messageCb = ack && function (reply, handle, sent) {
            message = Object.assign({ ack: ack }, reply)
            debug.enabled && debug.apply(0, [process.pid, '--- worker:messageCb#' + this.id, JSON.stringify(message)].concat(argsMap(arguments).slice(1)));
            this.send(message, handle, sent);
        }.bind(this);
    try {
        if (message.event) { // master request
            delete message.event && messageCb && delete message.ack; // remove event & ack attributes
            event.push('worker' + event[0].charAt(0).toUpperCase() + event[0].slice(1));
            this.emit(event[1], message, handle, messageCb) || debug(process.pid, 'onWorkerMessage:', event[0], '- not implemented', event[1]);
        }
        if (ack && exports.sendCb[ack]) { // worker response - invoke registered callback
            delete message.ack;
            exports.sendCb[ack].apply(this, arguments);
        }
    } catch (ex) {
        console.log('onWorkerMessage#' + worker.id, ex);
    }
});

process.on('delayedTerminate', function onDelayedTerminate(delay) { // true = delay; false = abort; undefined = terminate
    onDelayedTerminate.timeout = clearTimeout(onDelayedTerminate.timeout);
    if (delay === false) // terminate aborted
        return exports.retired = undefined;
    if (!delay) // timeout expired - terminate now
        return process.terminate();
    exports.retired || (exports.retired = new Date);
    onDelayedTerminate.timeout = setTimeout(onDelayedTerminate, 1000);
});

worker.on('workerRetire', function onWorkerRetire(retire, handle) { // _this_ is worker { event: 'retire' }, undefined
    debug.enabled && debug.apply(0, [process.pid, 'workerRetire#' + worker.id].concat(argsMap(arguments)));
    exports.retired || (exports.retired = new Date);
    Object.keys(exports.sessions).length || process.emit('delayedTerminate', true);
});

worker.on('workerJson', function onWorkerJson(json, handle, cb) { // _this_ is worker { ack, event: 'json', sid: '$origin$unique', [nowip|scaip|...] }, undefined
    debug.enabled && debug.apply(0, [process.pid, '>13 worker:json#' + this.id].concat(argsMap(arguments)));
    var message = {};
    if (json.sid in exports.sessions === false)
        message = { err: new Error('workerJson: unknown SID') };
    else if (!exports.sessions[json.sid].signal('json', json))
        message = { err: new Error('workerJson: un-usefully empty') };
    debug.enabled && debug(process.pid, '<14 worker:jsonCb#' + this.id, JSON.stringify(message));
    cb(message, handle, exports.sent('onWorkerJson'));
});

worker.on('workerFlush', function onWorkerFlush(flush, handle) { // _this_ is worker
    debug.enabled && debug.apply(0, [process.pid, '>-- worker:flush#' + this.id].concat(argsMap(arguments)));
    var session = exports.sessions[flush.sid];
    if (!session)
        return console.log('Error: non existant session', flush.sid);
    for (var route in exports.routes) // check the current set of routes
        if (exports.routes[route] === session) // any route referencing the session
            delete exports.routes[route]; // remove that route referencing the session
    session.enter(null);
});

worker.on('workerFetch', function onWorkerFetch(fetch, handle, cb) { // _this_ is worker
    debug.enabled && debug.apply(0, [process.pid, '>?? worker:fetch#' + this.id].concat(argsMap(arguments)));
    var reply = exports.sessions[fetch.sid] || { err: { name: 'Error', message: 'unknown session - ' + fetch.sid } };
    debug.enabled && debug(process.pid, '<?? worker:fetchCb#' + this.id, JSON.stringify(reply));
    cb(reply, handle, exports.sent('onWorkerFetch'));
});

var eslHandlers = {
    'esl::ready': onWorkerEslReady,
    'esl::event::CHANNEL_CREATE::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PROGRESS::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PROGRESS_MEDIA::*': onWorkerEslChannel,
    'esl::event::CHANNEL_ANSWER::*': onWorkerEslChannel,
    'esl::event::CHANNEL_DESTROY::*': onWorkerEslChannel,
    'esl::event::MESSAGE::*': onWorkerEslMessage,
    'esl::event::CUSTOM::*': onWorkerEslCustom,
};
for (var event in eslHandlers)
    esl.on(event, eslHandlers[event]);

var blankLine = /\b(worker|session|communicator|consumer)\b/;

function onWorkerEslChannel(evt, hdrs, body) { // {headers,hptr,type,body}, {'Content-Length','Content-Type'}, string
    esl.parseEvt.call(this, evt, hdrs, body);
    var first, session = undefined
        || exports.routes[evt.headers['Unique-ID']] // Communicator - existing session
        || exports.routes[evt.headers['Caller-Caller-ID-Number']] // Communicator - existing session
        || exports.routes[evt.headers['variable_appello_unique']]; // Consumer - existing session
    !session && evt.type === 'CHANNEL_CREATE' && blankLine.test(exports.debug.names.join()) && console.log(); // blank line
    debug(process.pid, evt.type, evt.headers['Unique-ID'], new Date);
    if (!session && !exports.retired && exports.isCommunicatorUser(evt.headers['Caller-Destination-Number']) && evt.type === 'CHANNEL_CREATE' && evt.headers['Caller-Direction'] === 'inbound')
        first = session = new main.modules.Session(evt, evt.headers['Caller-Destination-Number']);
    if (!session)
        return debug(evt.type, evt.headers['Unique-ID'], 'done');

    var anti = exports.sessions[session.sid];
    session.signal(evt.type, evt, !!first) || session.signal('CHANNEL_', evt, !!first);
    if (anti !== exports.sessions[session.sid]) {
        var event = anti ? 'expire' : 'create', send = { event: event, sid: session.sid };
        debug.enabled && debug(session.sid, '<?? worker:' + event + '#' + worker.id, JSON.stringify(send));
        anti || limit(main.cache.sessions, session); // cache each new session in the rolling sessions cache
        worker.send(send, exports.handle, exports.sent('onWorkerEslChannel'));
    }
    debug(process.pid, session.sid, evt.type, evt.headers['Unique-ID'], 'done');
}

function onWorkerEslMessage(evt, hdrs, body) {
    esl.parseEvt.call(this, evt, hdrs, body);
    var first, session = undefined
        || exports.routes[evt.headers['from_user']] // Communicator - existing session
        || exports.routes[evt.headers['to_user']]; // Consumer - existing session
    !session && blankLine.test(exports.debug.names.join()) && console.log(); // blank line
    debug(process.pid, evt.type, evt.headers['Event-Sequence'], new Date);
    if (!session && !exports.retired && exports.isCommunicatorUser(evt.headers['to_user']))
        first = session = new main.modules.Session(evt, evt.headers['to_user']);
    if (!session)
        return debug(process.pid, evt.type, evt.headers['Event-Sequence'], 'done');

    var anti = exports.sessions[session.sid];
    session.signal(evt.type, evt, !!first);
    if (anti !== exports.sessions[session.sid]) {
        var event = anti ? 'expire' : 'create', send = { event: event, sid: session.sid };
        debug.enabled && debug(session.sid, '<?? worker:' + event + '#' + worker.id, JSON.stringify(send));
        anti || limit(main.cache.sessions, session); // cache each new session in the rolling sessions cache
        worker.send(send, exports.handle, exports.sent('onWorkerEslMessage'));
    }
    debug(process.pid, evt.type, evt.headers['Event-Sequence'], 'done');
}

function onWorkerEslCustom(evt, hdrs, body) { // _this_ is the Connection
    if (evt.subclass !== 'appello::scaber')
        return;

    esl.parseEvt.call(this, evt, hdrs, body);
    var started = new Date(evt.headers['Scaber-Started']);
    debug(process.pid, 'eslCustom: recv:', started);
    if (exports.started < started) { // we are older so must retire
        exports.retired || (exports.retired = new Date);
        return Object.keys(exports.sessions).length || process.emit('delayedTerminate', true);
    } else if (exports.started > started) { // we are younger to re-announce
        onWorkerEslReady(); // re-announce our supremacy
    }
    process.emit('delayedTerminate', false); // we are the dominant worker for now
}

function onWorkerEslReady() { // _this_ is the Connection
    var evt = new modesl.Event('CUSTOM', 'appello::scaber');
    debug(process.pid, 'eslReady: send:', exports.started);
    evt.addHeader('Scaber-Started', exports.started.toJSON());
    esl.sendEventX(evt, function (err) {
        err && console.log('onWorkerEslReady:', err);
    });
}
