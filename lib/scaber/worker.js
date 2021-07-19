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
var rpscb = require('../rpscb');

main.cache.sessions = limit(10)

var worker = cluster.worker; //  **** BE CAREFUL **** - this is the prototype of this module's _exports_ object, not the actual _exports_ object
module.exports = Object.defineProperties(Object.assign(Object.setPrototypeOf(exports, cluster.worker), { // worker: disconnect, message
    appelloScaber: /\bappello=scaber\b:?(\w*):?(\w*)/, // regexp to recognise PSTN call for scaber
    configJson: configJson, // helper for harvesting database config data
    debug: require('debug'), // used by blankLine test
    e164: undefined, // general scaip inbound, set by onWorkerEslReady(), used by scaipCid2Tnu()
    getCommunicatorName: function getCommunicatorName(user) { // e.g. scaip-nrs@pers.appello.care
        var match = user.match(/^(\w+)/);
        return match && main.config.Communicators[match[1]] && match[1];
    },
    handle: undefined, // dummy passed to all messaging functions
    resetInterval: resetInterval, // helper to clear+set an Interval
    resetTimeout: resetTimeout, // helper to clear+set a Timeout
    retired: new Date, // start life retired, to be activated by our own Scaber-Started event
    routes: {}, // { origin => Session, unique => session, <Channel-Call-UUID> ==> session, ... }
    scaipCid2Tnu: scaipCid2Tnu, // helper to select appropriate dialing target number for controller
    sendCb: function sendCb(message, handle, cb) { // {}, handle, cb({}, handle)
        sendCb.ids || (sendCb.ids = 0);
        message = Object.assign({ ack: ++sendCb.ids }, message); // local clone
        sendCb[message.ack] = function _sendCb() {
            delete sendCb[message.ack] && cb.apply(this, arguments);
        };
        debug.enabled && debug(process.pid, '--- worker:sending#' + this.id, JSON.stringify(message), handle);
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
    configJson: { enumerable: false },
    debug: { enumerable: false },
    getCommunicatorName: { enumerable: false },
    handle: { enumerable: false, writable: false },
    resetInterval: { enumerable: false },
    resetTimeout: { enumerable: false },
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

process.on('sessionAnnc', function onSessionAnnc(session) {
    debug.enabled && debug(process.pid, session.sid, 'sessionAnnc:', JSON.stringify(session.routes));
    if (!session.routes.length)
        return;

    var send = { event: 'create', sid: session.sid };
    debug.enabled && debug(session.sid, '<?? worker:create#' + worker.id, JSON.stringify(send));
    worker.send(send, exports.handle, exports.sent('onSessionAnnc'));
});

process.on('sessionDone', function onSessionDone(session) {
    debug.enabled && debug(process.pid, session.sid, 'sessionDone:', JSON.stringify(session.routes));
    exports.retired && !Object.keys(exports.sessions).length && process.emit('delayedTerminate', true);
    untrain(session, undefined); // cleanup any learning for this session
    limit(main.cache.sessions, session); // cache each session in the rolling sessions cache
    if (!session.routes.length)
        return;

    var send = { event: 'expire', sid: session.sid };
    debug.enabled && debug(session.sid, '<?? worker:expire#' + worker.id, JSON.stringify(send));
    worker.send(send, exports.handle, exports.sent('onSessionDone'));
});

function untrain(session, from_user) {
    debug(session.sid, 'untrain:', session.training || '-', from_user || '-');
    var training = session.training;
    session.training = delete exports.trainings[session.training] && undefined; // only release once
    chain(function cleanup(err) {
        err && console.log(session.sid, 'untrain:', err);

    }, function () {
        if (!training) // no e164 to release
            return this();

        exports.sendCb({ event: 'release', e164: training }, exports.handle, this.noerror);

    }, function (object, handle) {
        if (!session.payload.mrq || process.env.NOTRAINING || session.context.notraining) // not SCAIP or TRAINING disabled, so training to cleanup
            return this(); // no SQL select/update
        else if (session.communicator.uuid && training) // received Communicator call and are training 
            null; // do SQL select/update (learn)
        else if (!session.communicator.uuid && session.routes.length) // no call from expected CLI 
            null; // do SQL select/update (unlearn)
        else
            return this(); // no SQL select/update

        // do SQL select/update to learn/unlearn
        this.index = session.sid;
        this.nameSlashed = '/scaber/svc/' + session.payload.service + '/cid/' + session.payload.mrq.cid[0] + '/e164';
        mysql('select * from config where nameSlashed=? and schemeId=0', [this.nameSlashed], this);

    }, function (configs, meta) {
        if (!configs) // only defined if doing a SQL select/update
            return this();

        mysql(mysql.mksql('config', { nameSlashed: this.nameSlashed, schemeId: 0, valueString: from_user || '' }, configs[0]), this);

    });
}

function scaipCid2Tnu(session, tag, cb) { // cb(err, tnu)
    debug(session.sid, 'scaipCid2Tnu:', tag);

    var match = tag.match(/^([^:]+:)(\+\d+)?/);
    if (match[2]) { // the SCAIP request supplied a reliable device CLI
        session.signal('route', [match[2].slice(1)]); // to receive all channel events for a Communicator given PSTN-CLI
        return cb(null, match[1] + '+' + exports.e164);
    }

    chain(cb, function () {
        this.index = session.sid;
        mysql('select * from config where nameSlashed=? and schemeId=0', ['/scaber/svc/' + session.payload.service + '/cid/' + session.payload.mrq.cid[0] + '/e164'], this); // plaintext

    }, function (configs, meta) { // [{id,nameSlashed,schemeId,touched,valueBoolean,valueNumber,valueString}]
        debug.enabled && debug(session.sid, 'scaipCid2Tnu:', JSON.stringify({ configs: configs }));
        if ((configs[0] || {}).valueString) {
            session.signal('route', [configs[0].valueString]); // to receive all channel events for a Communicator known PSTN-CLI
            return cb(null, tag + '+' + exports.e164); // have device call the common TNU
        }
        if (process.env.NOTRAINING || (session.context || {}).notraining)
            return cb();

        // controller CLI is unknown - acquire a training route
        exports.sendCb({ event: 'reserve' }, exports.handle, this.noerror);

    }, function (reserve, handle) { // { ok, e164 }, undefined
        debug.enabled && debug(session.sid, 'scaipCid2Tnu:', JSON.stringify({ reserve: reserve }));
        if (!reserve.e164) {
            console.log(session.sid, 'worker:scaipCid2Tnu failed to reserve training TNU', JSON.stringify({ reserve: reserve }));
            return this();
        }

        exports.trainings[session.training = reserve.e164] = session; // go with reserved training route
        this(null, tag + '+' + reserve.e164); // controller CLI is unknown - training route

    });
}

function resetInterval(handle, func, msec, arg0) { // utility function to clear+set a Timeout
    var sid = this instanceof String ? this + ' ': '';
    handle && clearInterval(handle);
    function workerInterval() {
        var hr = process.hrtime();
        debug.enabled && debug('+' + process.pid, sid + 'INTERVAL', new Date);
        func.apply(this, arguments);
        debug.enabled && debug('-' + process.pid, sid + 'INTERVAL', process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms')
    }
    switch (arguments.length) {
        case 0: return;
        case 1: return;
        case 2: return setInterval(workerInterval);
        case 3: return setInterval(workerInterval, msec);
        case 4: return setInterval(workerInterval, msec, arg0);
        default: return setInterval.apply(null, [workerInterval].concat(Array.from(arguments).slice(2)));
    }
}

function resetTimeout(handle, func, msec, arg0) { // utility function to clear+set a Timeout
    var sid = this instanceof String ? this + ' ' : '';
    handle && clearTimeout(handle);
    function workerTimeout() {
        var hr = process.hrtime();
        debug.enabled && debug('+' + process.pid, sid + 'TIMEOUT', new Date);
        func.apply(this, arguments);
        debug.enabled && debug('-' + process.pid, sid + 'TIMEOUT', process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms')
    }
    switch (arguments.length) {
        case 0: return;
        case 1: return;
        case 2: return setTimeout(workerTimeout);
        case 3: return setTimeout(workerTimeout, msec);
        case 4: return setTimeout(workerTimeout, msec, arg0);
        default: return setTimeout.apply(null, [workerTimeout].concat(Array.from(arguments).slice(2)));
    }
}

function configJson(names, obj, cb) { // [nameSlash's], {}, cb(err, obj)
    chain(cb, function () {
        mysql('select * from config where schemeId=0 and nameSlashed in (' + mysql.qmks(names) + ') order by valueNumber,length(nameSlashed)', names, this); // JSON

    }, function (configs, meta) { // [{id,nameSlashed,schemeId,touched,valueBoolean,valueNumber,valueString}, ...]
        for (var i in configs) {
            try {
                Object.assign(obj, JSON.parse(configs[i].valueString));
            } catch (ex) {
                console.log('configJson:', ex.message, configs[i].valueString);
            }
        }
        debug.enabled && debug(this.index, 'configJson:', JSON.stringify(obj));
        this(null, obj);

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
    'esl::event::CHANNEL_BRIDGE::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PROGRESS::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PROGRESS_MEDIA::*': onWorkerEslChannel,
    'esl::event::CHANNEL_ANSWER::*': onWorkerEslChannel,
    'esl::event::CHANNEL_DESTROY::*': onWorkerEslChannel,
    'esl::event::CHANNEL_PARK::*': onWorkerEslChannel,
    'esl::event::DETECTED_TONE::*': onWorkerEslTone,
    'esl::event::DTMF::*': onWorkerEslDtmf,
    'esl::event::MESSAGE::*': onWorkerEslMessage,
    'esl::event::RECV_INFO::*': onWorkerEslInfo,
    'esl::event::CUSTOM::*': onWorkerEslCustom,
};
for (var event in eslHandlers)
    esl.on(event, eslHandlers[event]);

var blankLine = /\b(worker|session|communicator|consumer)\b/;

onWorkerEslChannel.ree164 = /^\+?(\d+)$/;
function onWorkerEslChannel(evt, hdrs, body) { // {headers,hptr,type,body}, {'Content-Length','Content-Type'}, string
    var hr = process.hrtime();
    esl.parseEvt.call(this, evt, hdrs, body);
    var match, session, matched, training, first, hex, cid = 'unmatched', communicatorName;
    if (match = onWorkerEslChannel.ree164.exec(evt.headers['Caller-Caller-ID-Number']))
        evt.headers['_e164'] = match[1];

    if (session = exports.routes[evt.headers['Unique-ID']]) // Communicator - existing session
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.routes[evt.headers['_e164']]) // Communicator - existing session
        matched = { '_e164': evt.headers['_e164'] };
    else if (session = exports.routes[evt.headers['Caller-Caller-ID-Number']]) // Communicator - existing session
        matched = { 'Caller-Caller-ID-Number': evt.headers['Caller-Caller-ID-Number'] };
    else if (session = exports.routes[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    else if (session = exports.trainings[evt.headers['Caller-Destination-Number']]) // cid in CLI training
        matched = training = { training: evt.headers['Caller-Destination-Number'] };

    !session && evt.type === 'CHANNEL_CREATE' && blankLine.test(exports.debug.names.join()) && console.log('-'.repeat(40)); // blank line
    if (evt.type === 'CHANNEL_CREATE' && (hex = evt.headers['variable_sip_h_X-CDS-CallId']) && evt.headers['Call-Direction'] === 'inbound')
        cid = hex.match(/.{1,8}/g).map(x => parseInt(x, 16)).join('-') + ' H(' + hex + ')';
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, matched ? JSON.stringify({ matched: matched }) : cid);
    if (session || exports.retired || evt.type !== 'CHANNEL_CREATE' || evt.headers['Call-Direction'] !== 'inbound') {
        null; // ignore
    } else if (communicatorName = exports.getCommunicatorName(evt.headers['Caller-Destination-Number'])) { // SIP call to <protocol>@host
        if (communicatorName === 'scaip') // prevent SCAIP SIP CHANNEL_CREATE from spawning a Session
            esl.executeAsyncX('hangup', ['CHANNEL_UNACCEPTABLE'], evt.headers['Unique-ID']);
        else
            first = session = new main.modules.Session(evt, communicatorName); // (evt, 'communicatorName')
    } else if (!(match = (evt.headers['variable_sip_req_params'] || '').match(exports.appelloScaber))) { // PSTN call with appello=scaber parameter
        null;
    } else switch (match[1]) {
        case 'pnc':
            first = session = new main.modules.Session(evt, 'bs8521pnc', match[2]); // (evt, 'communicatorName', ?dialPrefix)
            break;

        default:
            first = session = new main.modules.Session(evt, main.config.Communicators.default || 'detect'); // (evt, 'communicatorName')
            break;
    }

    if (!session)
        return debug('-' + process.pid, evt.headers['Unique-ID'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms', 0);

    session.signal(evt.type, evt, !!first) || session.signal('CHANNEL_', evt, !!first);
    session.training && untrain(session, evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number']);
    debug('-' + process.pid, evt.headers['Unique-ID'], evt.type + (training ? ' trained' : ''), process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslTone(evt, hdrs, body) {
    var hr = process.hrtime();
    esl.parseEvt.call(this, evt, hdrs, body);
    var session, matched;
    if (!evt.headers['Unique-ID'])
        return;
    else if (session = exports.routes[evt.headers['Unique-ID']])
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.routes[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, evt.headers['Detected-Tone'], JSON.stringify({ matched: matched }) || 'unmatched');
    session && session.signal(evt.type, evt, false);
    debug('-' + process.pid, evt.headers['Unique-ID'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslDtmf(evt, hdrs, body) {
    var hr = process.hrtime();
    esl.parseEvt.call(this, evt, hdrs, body);
    var session, matched;
    if (session = exports.routes[evt.headers['Unique-ID']])
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.routes[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, evt.headers['DTMF-Digit'] + '@' + evt.headers['DTMF-Duration'], JSON.stringify({ matched: matched }) || 'unmatched');
    session ? session.signal(evt.type, evt, false) : debug(process.pid, 'routes:', JSON.stringify(Object.keys(exports.routes)));
    debug('-' + process.pid, evt.headers['Unique-ID'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslMessage(evt, hdrs, body) {
    var eventSequence = +evt.getHeader('Event-Sequence');
    if (onWorkerEslMessage.eventSequence >= eventSequence) // ignore repeat messages for the same event
        return;

    onWorkerEslMessage.eventSequence = eventSequence;
    var hr = process.hrtime(), hint = '';
    esl.parseEvt.call(this, evt, hdrs, body);
    process.emit('sipMessagePreProcess', evt); // opportunity to parse-body & assign a {scaber} for session identification
    var first, session, matched, communicatorName;
    if (session = exports.sessions[(evt.scaber || {}).sid]) // possibly set by 'process.emit('sipMessagePreProcess', evt)' above (e.g. scaip)
        matched = { 'sid': evt.scaber.sid };
    else if (session = exports.routes[evt.headers['from_user']]) // Communicator - existing session
        matched = { 'from_user': evt.headers['from_user'] };
    else if (session = exports.routes[evt.headers['to_user']]) // Consumer - existing session
        matched = { 'to_user': evt.headers['to_user'] };
    !session && blankLine.test(exports.debug.names.join()) && console.log('-'.repeat(40)); // blank line
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'] || evt.headers['Event-Sequence'], evt.type, new Date, JSON.stringify({ matched: matched }) || 'unmatched');
    if (exports.retired)
        hint = 'retired';
    else if (session)
        hint = 'existing';
    else if (!evt.parsed.mrq)
        hint = '!scaip'
    else if (evt.headers['from_user'] !== evt.parsed.mrq.cid[0])
        hint = 'from!cid';
    else if (communicatorName = exports.getCommunicatorName(evt.headers['to_user']))
        first = session = new main.modules.Session(evt, communicatorName);
    if (!session)
        return debug('-' + process.pid, evt.headers['Unique-ID'] || evt.headers['Event-Sequence'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms', hint);

    session.signal(evt.type, evt, !!first);
    debug('-' + process.pid, evt.headers['Unique-ID'] || evt.headers['Event-Sequence'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslInfo(evt, hdrs, body) {
    var hr = process.hrtime();
    esl.parseEvt.call(this, evt, hdrs, body);
    var session, matched;
    if (session = exports.routes[evt.headers['Unique-ID']])
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.routes[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, evt.body, JSON.stringify({ matched: matched }) || 'unmatched');
    session ? session.signal(evt.type, evt, false) : debug(process.pid, 'routes:', JSON.stringify(Object.keys(exports.routes)));
    debug('-' + process.pid, evt.headers['Unique-ID'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslCustom(evt, hdrs, body) { // _this_ is the Connection
    switch (evt.subclass) {
        case 'appello::scaber':
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
            break;
    }
}

function onWorkerEslReady() { // _this_ is the Connection
    delete onWorkerEslMessage.eventSequence; // reset duplicate MESSAGE filter
    chain(function cleanup(err) {
        err && console.log(process.pid, 'onWorkerEslReady:', err);

    }, function () {
        this.index = 'startup';
        mysql('select * from config where schemeId=0 and nameSlashed=?', ['/scaber/fqdn/' + os.hostname() + '/e164s'], this); // plaintext

    }, function (configs, meta) {
        var e164s = JSON.parse((configs[0] || { valueString: null }).valueString) || [];
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

mysql.running.then(function () { // database is ready - fetch our TLS certificate used by HTTPS:SNICallback
    Object.assign(main.cache, { tls: {} });

    // usually from nexus1 running certbot with a POST to /maintain/cert/:fqdn
    rpscb.on('certificate', function onCertificateRpscb(fqdn, cert, chain, key) { // cb(err, ourUrl)
        process.emit('certificate', { fqdn: fqdn, cert: cert, chain: chain, key: key });
    });

    chain(null, function () {
        this.index = 'fetchCert';
        mysql('select f.*,l.chain from fqdns f left join leChains l on f.chainId=l.id where f.fqdn=?', [main.secrets.fqdn], this);

    }, function (fqdns, meta) {
        if (!fqdns.length)
            return;
        var fqdn = fqdns.shift();
        process.emit('certificate', { fqdn: fqdn.fqdn, cert: fqdn.cert, chain: fqdn.chain, key: fqdn.privkey });

    });
});

process.on('certificate', function onCertificateWorker(dict) { // { fqdn, cert, chain, key }
    if (dict.fqdn !== main.secrets.fqdn)
        return;
    debug('onCertificateWorker:', dict.fqdn);
    Object.assign(main.cache.tls, dict);
});
