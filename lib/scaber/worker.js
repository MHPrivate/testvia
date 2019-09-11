#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cluster = require('cluster');
var debug = require('debug')('worker');
var esl = require('../esl');
var events = require('events');
var main = require.main.exports;

var worker = cluster.worker;
module.exports = Object.defineProperties(Object.assign(Object.setPrototypeOf(exports, cluster.worker), { // worker: disconnect, message
    handle: undefined, // dummy passed to all messaging functions
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
    routes: {}, // { origin => Session, unique => session, <Channel-Call-UUID> ==> session, ... }
    sent: function sent(txt) { // callback factory helper for calls to worker.send(message, handle, cb)
        return function (err) { err && console.log(txt + ':', err) };
    },
    sessions: {}, // { $origin$unique => Session }
}), {
    handle: { enumerable: false, writable: false },
    sendCb: { enumerable: false },
    sent: { enumerable: false },
});

worker.on('disconnect', function onWorkerDisconnect() {
    debug.enabled && debug.apply(0, ['workerDisconnect#' + worker.id].concat(argsMap(arguments)));
});

worker.on('message', function onWorkerMessage(message, handle) { // _this_ is worker - { event, sid, ... } OR { ack, ?err, ?code }
    debug.enabled && debug.apply(0, ['--- worker:message#' + this.id].concat(argsMap(arguments)));
    var event = [message.event], ack = message.ack, messageCb = ack && function (reply, handle, sent) {
            message = Object.assign({ ack: ack }, reply)
            debug.enabled && debug.apply(0, ['--- worker:messageCb#' + this.id, JSON.stringify(message)].concat(argsMap(arguments).slice(1)));
            this.send(message, handle, sent);
        }.bind(this);
    try {
        if (message.event) { // master request
            delete message.event && messageCb && delete message.ack; // remove event & ack attributes
            event.push('worker' + event[0].charAt(0).toUpperCase() + event[0].slice(1));
            this.emit(event[1], message, handle, messageCb) || debug('onWorkerMessage:', event[0], '- not implemented', event[1]);
        } if (ack && exports.sendCb[ack]) { // worker response - invoke registered callback
            delete message.ack;
            exports.sendCb[ack].apply(this, arguments);
        }
    } catch (ex) {
        console.log('onWorkerMessage#' + worker.id, ex);
    }
});

worker.on('workerRetire', function onWorkerRetire(retire, handle) { // _this_ is worker { event: 'retire' }, undefined
    debug.enabled && debug.apply(0, ['workerRetire#' + worker.id].concat(argsMap(arguments)));
    main.control.retired || (main.control.retired = new Date);
    Object.keys(exports.sessions).length || process.terminate();
});

worker.on('workerAuction', function onWorkerAuction(auction, handle) { // _this_ is worker { event: 'auction', origin, unique }, undefined
    debug.enabled && debug.apply(0, ['>02 worker:auction#' + this.id].concat(argsMap(arguments)));
    main.modules.Session({ headers: { 'Caller-Caller-ID-Number': auction.origin, 'variable_sip_call_id': auction.unique } });
});

worker.on('workerJson', function onWorkerJson(json, handle, cb) { // _this_ is worker { ack, event: 'json', sid: '$origin$unique', [nowip|scaip|...] }, undefined
    debug.enabled && debug.apply(0, ['>13 worker:json#' + this.id].concat(argsMap(arguments)));
    var message = {};
    if (json.sid in exports.sessions === false)
        message = { err: new Error('workerJson: unknown SID') };
    else if (!exports.sessions[json.sid].signal('jsonReceived', json))
        message = { err: new Error('workerJson: un-usefully empty') };
    debug.enabled && debug('<14 worker:jsonCb#' + this.id, JSON.stringify(message));
    cb(message, handle, exports.sent('onWorkerJson'));
});

worker.on('workerFlush', function onWorkerFlush(flush, handle) { // _this_ is worker
    debug.enabled && debug.apply(0, ['>-- worker:flush#' + this.id].concat(argsMap(arguments)));
    var session = exports.sessions[flush.sid];
    if (!session)
        return console.log('Error: non existant session', flush.sid);
    for (var route in exports.routes) // check the current set of routes
        if (exports.routes[route] === session) // any route referencing the session
            delete exports.routes[route]; // remove that route referencing the session
    session.enter(null);
});

worker.on('workerFetch', function onWorkerFetch(fetch, handle, cb) { // _this_ is worker
    debug.enabled && debug.apply(0, ['>?? worker:fetch#' + this.id].concat(argsMap(arguments)));
    var reply = exports.sessions[fetch.sid] || { err: { name: 'Error', message: 'unknown session - ' + fetch.sid } };
    debug.enabled && debug('<?? worker:fetchCb#' + this.id, JSON.stringify(reply));
    cb(reply, handle, exports.sent('onWorkerFetch'));
});

var eslHandlers = {
    'esl::event::CHANNEL_CREATE::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PROGRESS::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PROGRESS_MEDIA::*': onWorkerEslChannel,
    'esl::event::CHANNEL_ANSWER::*': onWorkerEslChannel,
    'esl::event::CHANNEL_DESTROY::*': onWorkerEslChannel,
    'esl::event::MESSAGE::*': onWorkerEslMessage,
};
for (var event in eslHandlers)
    esl.on(event, eslHandlers[event]);

function onWorkerEslChannel(evt, hdrs, body) { // {headers,hptr,type,body}, {'Content-Length','Content-Type'}, string
    esl.parseEvt.call(this, evt, hdrs, body);
    var aleg = (!evt.headers['variable_appello_consumer']) && ['nowip', 'scaip'].includes(evt.headers['Caller-Destination-Number']); // aleg ? communicator : consumer
    if (evt.headers['variable_appello_unique'] in exports.routes) { // outbound a-leg OR b-leg
        if (!exports.routes[evt.headers['variable_appello_unique']].signal(evt.type, evt, aleg))
            exports.routes[evt.headers['variable_appello_unique']].signal('CHANNEL_', evt, aleg);
    } else if (evt.headers['Unique-ID'] in exports.routes) { // inbound a-leg
        if (!exports.routes[evt.headers['Unique-ID']].signal(evt.type, evt, aleg))
            exports.routes[evt.headers['Unique-ID']].signal('CHANNEL_', evt, aleg);
    } else if (aleg && evt.type === 'CHANNEL_CREATE' && evt.headers['Caller-Direction'] === 'inbound') {
        new main.modules.Session(evt);
    } else {
        debug.enabled && debug('onWorkerEslChannel:', aleg?'aleg':'bleg', evt.type, 'not processed');
    }
}

function onWorkerEslMessage(evt, hdrs, body) {
    esl.parseEvt.call(this, evt, hdrs, body);
    var aleg = ['nowip','scaip'].includes(evt.headers['to_user']); // aleg ? communicator : consumer
    if (evt.headers[aleg ? 'from_user' : 'to_user'] in exports.routes)
        exports.routes[evt.headers[aleg ? 'from_user' : 'to_user']].signal(evt.type, evt, aleg);
}
