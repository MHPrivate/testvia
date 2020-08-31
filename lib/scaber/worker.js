#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('worker');
var esl = require('../esl');
var events = require('events');
var limit = require('../limit');
var main = require.main.exports;
var modesl = require('modesl');
var mysql = require('../mysql');
var os = require('os');

main.cache.sessions = limit(10)

var worker = cluster.worker; //  **** BE CAREFUL **** - this is the prototype of this module's _exports_ object, not the actual _exports_ object
module.exports = Object.defineProperties(Object.assign(Object.setPrototypeOf(exports, cluster.worker), { // worker: disconnect, message
    debug: require('debug'),
    e164: undefined,
    handle: undefined, // dummy passed to all messaging functions
    isCommunicatorUser: function isCommunicatorUser(user) {
        return user in main.config.Communicators;
    },
    retired: new Date, // start life retired, to be activated by our own Scaber-Started event
    routes: {}, // { origin => Session, unique => session, <Channel-Call-UUID> ==> session, ... }
    scaipCid2Tnu: scaipCid2Tnu, // helper to select appropriate dialing target number for controller
    sendCb: function sendCb(message, handle, cb) { // {}, handle, cb({}, handle)
        sendCb.ids || (sendCb.ids = 0);
        message = Object.assign({ ack: ++sendCb.ids }, message); // local clone
        sendCb[message.ack] = function _sendCb() {
            delete sendCb[message.ack] && cb.apply(this, arguments);
        };
        debug(process.pid, '--- worker:sending#' + this.id, JSON.stringify(message), handle);
        this.__proto__.send(message, handle, function (err) {
            err && delete sendCb[message.ack] && console.log('worker:sendCb:', err);
        });
    },
    sent: function sent(txt) { // callback factory helper for calls to worker.send(message, handle, cb)
        return function (err) { err && console.log(txt + ':', err) };
    },
    sessions: {}, // { $origin$unique => Session } - deleted by session:leave, added by session:CHANNEL_CREATE / session:MESSAGE
    started: new Date(Date.now() - process.uptime() * 1000), // used to establish worker supremacy
    trainings: {}, // { e164 => Session } - deleted by worker:untrain, added by worker:scaipCid2Tnu
    untrain: untrain,
}), {
    debug: { enumerable: false },
    handle: { enumerable: false, writable: false },
    isCommunicatorUser: { enumerable: false },
    scaipCid2Tnu: { enumerable: false },
    sendCb: { enumerable: false },
    sent: { enumerable: false },
    untrain: { enumerable: false },
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

process.on('sessionDone', function onSessionDone(session) {
    debug(process.pid, 'sessionDone:', session.sid);
    exports.retired && !Object.keys(exports.sessions).length && process.emit('delayedTerminate', true);
    untrain(session, undefined); // cleanup any learning for this session
    if (!session.established) // will be false where session is short-lived - e.g. just to process a heartbeat
        return;

    var send = { event: 'expire', sid: session.sid };
    debug.enabled && debug(session.sid, '<?? worker:expire#' + worker.id, JSON.stringify(send));
    limit(main.cache.sessions, session); // cache each established(long-lived) session in the rolling sessions cache
    worker.send(send, exports.handle, exports.sent('onSessionDone'));
});

function untrain(session, from_user) {
    debug(session.sid, 'untrain:', from_user);
    chain(function cleanup(err) {
        err && console.log(session.sid, 'untrain:', err);

    }, function loop(object, handle) {
        //debug.enabled && debug(session.sid, 'untrain:loop:', JSON.stringify(object));
        for (var e164 in exports.trainings) {
            //debug(session.sid, 'untrain:for:', e164);
            if (exports.trainings[e164] === session && delete exports.trainings[e164]) {
                //debug(session.sid, 'untrain:for:if:', e164);
                return this.untrained = exports.sendCb({ event: 'release', e164: e164 }, exports.handle, loop.bind(this)) || true;
            }
        }

        //debug(session.sid, 'untrain:', JSON.stringify({ untrained: this.untrained }));
        this.index = session.sid;
        if (from_user) // training success - record learnt CLI for next time
            mysql(mysql.mksql('config', { nameSlashed: '/scaip/cid/' + session.origin + '/e164', schemeId: 0, valueString: from_user }), this);
        else if (session.established && !session.communicator.uuid) // training failure - flush so as to relearn next time
            mysql('delete from config where schemeId=0 and nameSlashed=?', ['/scaip/cid/' + session.origin + '/e164'], this);
        else
            this();

    });
}

function scaipCid2Tnu(session, cid, cb) { // cb(err, tnu)
    debug(session.sid, 'scaipCid2Tnu:');
    chain(cb, function () {
        this.index = session.sid;
        mysql('select * from config where schemeId=0 and nameSlashed=?', ['/scaip/cid/' + cid + '/e164'], this);

    }, function (configs, meta) { // [{id,nameSlashed,schemeId,touched,valueBoolean,valueNumber,valueString}]
        debug.enabled && debug(session.sid, 'scaipCid2Tnu:', JSON.stringify({ configs: configs }));
        if (!configs.length) // controller CLI is unknown - actuire a training route
            return exports.sendCb({ event: 'reserve' }, exports.handle, this.noerror);

        session.signal('route', [configs[0].valueString]); // to match Communicator leg by known PSTN-CLI
        cb(null, 'gsm:+' + exports.e164); // supply common TNU

    }, function (reserve, handle) { // { ok, e164 }, undefined
        debug.enabled && debug(session.sid, 'scaipCid2Tnu:', JSON.stringify({ reserve: reserve }));
        reserve.e164 || console.log(session.sid, 'worker:scaipCid2Tnu failed to reserve training TNU', JSON.stringify({ reserve: reserve }));
        var gsm = reserve.e164 || exports.e164; // go with reserved training route else common TNU
        exports.trainings[gsm] = session;
        this(null, 'gsm:+' + gsm); // controller CLI is unknown - training route

    });
}

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

onWorkerEslChannel.ree164 = /^\+?(\d+)$/;
function onWorkerEslChannel(evt, hdrs, body) { // {headers,hptr,type,body}, {'Content-Length','Content-Type'}, string
    esl.parseEvt.call(this, evt, hdrs, body);
    var match = onWorkerEslChannel.ree164.exec(evt.headers['Caller-Caller-ID-Number']);
    if (match)
        evt.headers['_e164'] = match[1];
    var first, session, training, matched;
    if (session = exports.routes[evt.headers['Unique-ID']]) // Communicator - existing session
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.routes[evt.headers['_e164']])// Communicator - existing session
        matched = { '_e164': evt.headers['_e164'] };
    else if (session = exports.routes[evt.headers['Caller-Caller-ID-Number']]) // Communicator - existing session
        matched = { 'Caller-Caller-ID-Number': evt.headers['Caller-Caller-ID-Number'] };
    else if (session = exports.routes[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    else if (session = exports.trainings[evt.headers['Caller-Destination-Number']]) // cid in CLI training
        matched = training = { training: evt.headers['Caller-Destination-Number'] };
    !session && evt.type === 'CHANNEL_CREATE' && blankLine.test(exports.debug.names.join()) && console.log('-'.repeat(40)); // blank line
    debug.enabled && debug(process.pid, evt.type, evt.headers['Unique-ID'], new Date, JSON.stringify(matched) || 'unmatched');
    if (!session && !exports.retired && exports.isCommunicatorUser(evt.headers['Caller-Destination-Number']) && evt.type === 'CHANNEL_CREATE' && evt.headers['Caller-Direction'] === 'inbound')
        first = session = new main.modules.Session(evt, evt.headers['Caller-Destination-Number']);
    if (!session)
        return debug(evt.type, evt.headers['Unique-ID'], 'done');

    session.signal(evt.type, evt, !!first) || session.signal('CHANNEL_', evt, !!first);
    if (!session.established && exports.sessions[session.sid]) {
        var send = { event: 'create', sid: session.sid };
        debug.enabled && debug(session.sid, '<?? worker:create#' + worker.id, JSON.stringify(send));
        worker.send(send, exports.handle, exports.sent('onWorkerEslChannel'));
    }
    session.established || (session.established = true);
    training && untrain(session, evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number']);
    debug(process.pid, session.sid, evt.type, evt.headers['Unique-ID'], training ? 'done trained' : 'done');
}

function onWorkerEslMessage(evt, hdrs, body) {
    esl.parseEvt.call(this, evt, hdrs, body);
    process.emit('sipMessagePreProcess', evt); // opportunity to parse-body & assign a {scaber} for session identification
    var first, session, matched;
    if (evt.scaber)
        matched = (session = exports.routes[evt.scaber.sid]) && { 'sid': evt.scaber.sid };
    else if (session = exports.routes[evt.headers['from_user']]) // Communicator - existing session
        matched = { 'from_user': evt.headers['from_user'] };
    else if (session = exports.routes[evt.headers['to_user']]) // Consumer - existing session
        matched = { 'to_user': evt.headers['to_user'] };
    !session && blankLine.test(exports.debug.names.join()) && console.log('-'.repeat(40)); // blank line
    debug.enabled && debug(process.pid, evt.type, evt.headers['Event-Sequence'], new Date, JSON.stringify(matched) || 'unmatched');
    if (!session && !exports.retired && exports.isCommunicatorUser(evt.headers['to_user']))
        first = session = new main.modules.Session(evt, evt.headers['to_user']);
    if (!session)
        return debug(process.pid, evt.type, evt.headers['Event-Sequence'], 'done');

    session.signal(evt.type, evt, !!first);
    if (!session.established && exports.sessions[session.sid]) {
        var send = { event: 'create', sid: session.sid };
        debug.enabled && debug(session.sid, '<?? worker:create#' + worker.id, JSON.stringify(send));
        worker.send(send, exports.handle, exports.sent('onWorkerEslMessage'));
    }
    session.established || (session.established = true);
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
    chain(function cleanup(err) {
        err && console.log(process.pid, 'onWorkerEslReady:', err);

    }, function () {
        this.index = 'startup';
        mysql('select * from config where schemeId=0 and nameSlashed=?', ['/scaber/fqdn/' + os.hostname() + '/e164s'], this);

    }, function (configs, meta) {
        var e164s = JSON.parse((configs[0] || { valueString: null }).valueString);
        exports.e164 = e164s.shift();
        var provide = { event: 'provide', e164s: e164s };
        exports.sendCb(provide, exports.handle, this.noerror);

    }, function (object, handle) {
        var evt = new modesl.Event('CUSTOM', 'appello::scaber');
        debug(process.pid, 'eslReady: send:', exports.started);
        evt.addHeader('Scaber-Started', exports.started.toJSON());
        esl.sendEventX(evt, function (err) {
            err && console.log('onWorkerEslReady:', err);
        });

    });
}
