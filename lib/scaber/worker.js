#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    cluster = require('cluster'),
    debug = require('debug')('worker'),
    esl = require('../esl'),
    events = require('events'),
    limit = require('../limit'),
    main = require.main.exports,
    modesl = require('modesl'),
    mysql = require('../mysql'),
    os = require('os'),
    rpscb = require('../rpscb');

main.cache.sessions = limit(10)

var worker = cluster.worker; //  **** BE CAREFUL **** - this is the prototype of this module's _exports_ object, not the actual _exports_ object
module.exports = Object.defineProperties(Object.assign(Object.setPrototypeOf(exports, cluster.worker), { // worker: disconnect, message
    appelloScaber: /\bappello=scaber\b:?(\w*):?(\w*)/, // regexp to recognise PSTN call for scaber
    uagentScaber: main.secrets.scaberUserAgentRE ? new RegExp(main.secrets.scaberUserAgentRE) : /_scaber\b/, // regexp to recognise UserAgent for scaber
    configJson: configJson, // helper for harvesting database config data
    debug: require('debug'), // used by blankLine test
    e164: undefined, // general scaip inbound, set by onWorkerEslReady(), used by scaipCid2Tnu()
    getCommunicatorName: function getCommunicatorName(user) { // e.g. scaip-nrs@pers.appello.care
        var match = (user || '').match(/^(\w+)/);
        return match && main.config.Communicators[match[1]] && match[1];
    },
    handle: undefined, // dummy passed to all messaging functions
    legDtmf: legDtmf, // helper to facilitate auto allow/block sending of dtmf
    resetInterval: resetInterval, // helper to clear+set an Interval
    resetTimeout: resetTimeout, // helper to clear+set a Timeout
    retired: new Date, // start life retired, to be activated by our own Scaber-Started event
    scaipCid2Tnu: scaipCid2Tnu, // helper to select appropriate dialing target number for controller
    sendCb: function sendCb(message, handle, cb) { // {}, handle, cb({}, handle)
        sendCb.ids || (sendCb.ids = 0);
        message = Object.assign({ ack: ++sendCb.ids }, message); // local clone
        sendCb[message.ack] = function _sendCb() {
            delete sendCb[message.ack] && cb.apply(this, arguments);
        };
        debug.enabled && debug(process.pid, '--- worker:sending#' + this.id, UTIL.stringify(message), handle);
        this.__proto__.send(message, handle, function (err) {
            err && delete sendCb[message.ack] && console.log('worker:sendCb:', err);
        });
    },
    sent: function sent(txt) { // callback factory helper for calls to worker.send(message, handle, cb)
        return function (err) { err && console.log(txt + ':', err) };
    },
    sessions: {}, // { $origin$unique => Session } - deleted by session:leave, added by session:CHANNEL_CREATE / session:MESSAGE
    started: new Date(Date.now() - process.uptime() * 1000), // used to establish worker supremacy
    tags: {}, // { origin => Session, unique => session, <Channel-Call-UUID> ==> session, ... }
    trainings: {}, // { e164 => Session } - deleted by worker:untrain, added by worker:scaipCid2Tnu
    untrain: untrain,
    uuid: undefined, // scaber instance - used for bsia-receiver messaging
}), {
    configJson: { enumerable: false },
    debug: { enumerable: false },
    getCommunicatorName: { enumerable: false },
    handle: { enumerable: false, writable: false },
    legDtmf: { enumerable: false, writable: false },
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
            message = Object.assign({ ack: ack }, reply);
            debug.enabled && debug.apply(0, [process.pid, '--- worker:messageCb#' + this.id, UTIL.stringify(message)].concat(argsMap(arguments).slice(1)));
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
    exports.uuid && rpscb.publish('bsia:receivers', { buid: exports.uuid, host: os.hostname(), hint: 'onDelayedTerminate' });
    onDelayedTerminate.timeout = setTimeout(onDelayedTerminate, 1000);
});

process.on('sessionAnnc', function onSessionAnnc(session) {
    debug.enabled && debug(process.pid, session.sid, 'sessionAnnc:', UTIL.stringify(session.tags));
    if (!session.tags.length)
        return;

    //var send = { event: 'create', sid: session.sid };
    //debug.enabled && debug(session.sid, '<?? worker:create#' + worker.id, UTIL.stringify(send));
    //worker.send(send, exports.handle, exports.sent('onSessionAnnc'));
});

process.on('sessionDone', function onSessionDone(session) {
    debug.enabled && debug(process.pid, session.sid, 'sessionDone:', UTIL.stringify(session.tags));
    exports.retired && !Object.keys(exports.sessions).length && process.emit('delayedTerminate', true);
    untrain(session, undefined); // cleanup any learning for this session
    limit(main.cache.sessions, session); // cache each session in the rolling sessions cache
    if (!session.tags.length)
        return;

    //var send = { event: 'expire', sid: session.sid };
    //debug.enabled && debug(session.sid, '<?? worker:expire#' + worker.id, UTIL.stringify(send));
    //worker.send(send, exports.handle, exports.sent('onSessionDone'));
});

function legDtmf(leg, dtmf, lock, diagnostic, cb) {
    var inband = leg.session.context.inband,
        ms = 0,
        tgml;
    switch (typeof inband) {
        case 'undefined': break; // use send_dtmf
        case 'object': break; // use gentones TGML
        default: inband ? {} : undefined; break; // typically 'boolean'
    }

    var map = legDtmf[dtmf.toLowerCase()] || {};
    if (typeof dtmf === 'string' && /[%=;|]/.test(dtmf)) // use explicitly supplied TGML
        ms = esl.tgmlMs(tgml = dtmf);
    else if (leg.stmf) // use supplied TGML or convert DTMF to gentones STMF-TGML
        ms = esl.tgmlMs(tgml = map.tgml || esl.dtmf2stmf(dtmf, inband));
    else if (inband) // convert DTMF to gentones DTMF-TGML
        ms = esl.tgmlMs(tgml = esl.dtmf2tgml(dtmf, inband));
    else // we're sending DTMF as rfc2833
        ms = esl.dtmfMs(dtmf);
    (tgml || dtmf) && leg.session.signal('diagnostic', map.diag || diagnostic || '?');
    debug.enabled && debug(leg.session.sid, 'legDtmf:', UTIL.stringify({ dtmf: dtmf, passDtmf: leg.session.context.passDtmf || false }), new Date);
    if (tgml) { // have TGML - just send
        debug && debug(leg.session.sid, 'gentones', tgml, ms + 'ms', new Date);
        esl.executeAsyncX('gentones', tgml, leg.uuid, cb);
        return ms;
    }

    // sending rfc2833 DTMF - manage masking
    if (typeof leg.session.passDtmf === 'boolean') { // per-session attribute has been defined
        if (leg.session.passDtmf) // per-session attribute permits DTMF between bridged legs - else prevents it
            lock = undefined;
    } else if (leg.session.context.passDtmf) { // context attribute permits DTMF between bridged legs
        lock = undefined;
    }
    chain(cb, function () {
        if ([undefined, true].includes(lock)) // skip if lock is undefined OR true
            return this();

        debug && debug(leg.session.sid, 'legDtmf allow_dtmf', new Date);
        esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], leg.uuid, this);

    }, function () {
        if (!dtmf) // skip if no DTMF to send (allow/block control only)
            return this();

        debug && debug(leg.session.sid, 'legDtmf send_dtmf', dtmf, ms + 'ms', new Date);
        esl.executeAsyncX('send_dtmf', [dtmf], leg.uuid, this);

    }, function () {
        if ([undefined, false].includes(lock)) // skip if lock is undefined OR false
            return this();

        debug && debug(leg.session.sid, 'legDtmf block_dtmf', new Date);
        esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], leg.uuid, this);

    });
    return ms;
}
Object.assign(legDtmf, {
    '1@500': { diag: 'vup', tgml: '%(75,5,697);%(75,5,1209);'.repeat(3) },
    '2@500': { diag: 'vdn', tgml: '%(75,5,697);%(75,5,1336);'.repeat(3) },
    '3@500': { diag: 'ulk', tgml: '%(75,5,697);%(75,5,1447);'.repeat(3) },
    'c@500': { diag: 'spk', tgml: '%(75,5,852);%(75,5,1633);'.repeat(3) },
    '*@500': { diag: 'lsn', tgml: '%(75,5,941);%(75,5,1209);'.repeat(3) },
    '*@500+#@2000': { diag: 'cls', tgml: '%(75,5,941);%(75,5,1477);'.repeat(2) },
    '701@80': { diag: 'dpx' },
    '703@80': { diag: 'spx' },
    '1@400': { diag: '=1=' }, '2@400': { diag: '=2=' }, '3@400': { diag: '=3=' }, 'a@400': { diag: '=a=' },
    '4@400': { diag: '=4=' }, '5@400': { diag: '=5=' }, '6@400': { diag: '=6=' }, 'b@400': { diag: '=b=' },
    '7@400': { diag: '=7=' }, '8@400': { diag: '=8=' }, '9@400': { diag: '=9=' }, 'c@400': { diag: '=c=' },
    '*@400': { diag: '=*=' }, '0@400': { diag: '=0=' }, '#@400': { diag: '=#=' }, 'd@400': { diag: '=d=' },
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

        exports.sendCb({ event: 'release', e164: training, _: session.sid }, exports.handle, this.noerror);

    }, function (object, handle) {
        if (!session.payload.mrq || process.env.NOTRAINING || session.context.notraining) // not SCAIP or TRAINING disabled, so training to cleanup
            return this(); // no SQL select/update
        else if (session.communicator.uuid && training) // received Communicator call and are training 
            null; // do SQL select/update (learn)
        else if (!session.communicator.uuid && session.tags.length) // no call from expected CLI
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
        session.signal('tag', [match[2].slice(1)]); // to receive all channel events for a Communicator given PSTN-CLI
        return cb(null, {tnu: match[1] + '+' + exports.e164, cli: match[2]});
    }

    chain(cb, function () {
        this.index = session.sid;
        mysql('select * from config where nameSlashed=? and schemeId=0', ['/scaber/svc/' + session.payload.service + '/cid/' + session.payload.mrq.cid[0] + '/e164'], this); // plaintext

    }, function (configs, meta) { // [{id,nameSlashed,schemeId,touched,valueBoolean,valueNumber,valueString}]
        debug.enabled && debug(session.sid, 'scaipCid2Tnu:', UTIL.stringify({ configs: configs }));
        if ((configs[0] || {}).valueString) {
            session.signal('tag', [configs[0].valueString]); // to receive all channel events for a Communicator known PSTN-CLI
            return cb(null, {tnu: tag + '+' + exports.e164, cli: configs[0].valueString}); // have device call the common TNU
        }
        if (process.env.NOTRAINING || (session.context || {}).notraining)
            return cb();

        // controller CLI is unknown - acquire a training DDI
        exports.sendCb({ event: 'reserve', _: session.sid }, exports.handle, this.noerror);

    }, function (reserve, handle) { // { ok, e164 }, undefined
        debug.enabled && debug(session.sid, 'scaipCid2Tnu:', UTIL.stringify({ reserve: reserve }));
        if (!reserve.e164) {
            console.log(session.sid, 'worker:scaipCid2Tnu failed to reserve training TNU', UTIL.stringify({ reserve: reserve }));
            return this();
        }

        exports.trainings[session.training = reserve.e164] = session; // go with reserved training DDI
        this(null, {tnu: tag + '+' + reserve.e164}); // controller CLI is unknown - training DDI

    });
}

function resetInterval(handle, func, msec, arg0) { // utility function to clear+set a Timeout
    var sid = this instanceof String ? this + ' ': '';
    handle && resetInterval.log && debug('resetInterval:', sid + (func ? 'RESET:' : 'CLEAR'), callsites()[1].toString());
    handle && clearInterval(handle);
    if (arguments.length > 1 && typeof func !== 'function')
        debug('resetInterval: non-function from', callsites()[1].toString());
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
    resetTimeout.log && debug('resetTimeout:', sid + (!func ? 'CLEAR:' : !handle ? `SET:${msec}` : `RESET:${msec}`), callsites()[1].toString());
    handle && clearTimeout(handle);
    if (arguments.length > 1 && typeof func !== 'function')
        debug('resetTimeout: non-function from', callsites()[1].toString());
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
        for (var i in obj) {
            if (obj[i] === null)
                delete obj[i];
        }
        debug.enabled && debug(this.index, 'configJson:', UTIL.stringify(obj));
        this(null, obj);

    });
}

worker.on('workerRetire', function onWorkerRetire(retire, handle) { // _this_ is worker { event: 'retire' }, undefined
    debug.enabled && debug.apply(0, [process.pid, 'workerRetire#' + worker.id].concat(argsMap(arguments)));
    exports.retired || (exports.retired = new Date);
    exports.uuid && rpscb.publish('bsia:receivers', { buid: exports.uuid, host: os.hostname(), hint: 'onWorkerRetire' });
    Object.keys(exports.sessions).length || process.emit('delayedTerminate', true);
});

worker.on('workerJson', function onWorkerJson(json, handle, cb) { // _this_ is worker { ack, event: 'json', sid: '$origin$unique', [nowip|scaip|...] }, undefined
    debug.enabled && debug.apply(0, [process.pid, '>13 worker:json#' + this.id].concat(argsMap(arguments)));
    var message = {};
    if (json.sid in exports.sessions === false)
        message = { err: new Error('workerJson: unknown SID') };
    else if (!exports.sessions[json.sid].signal('json', json))
        message = { err: new Error('workerJson: un-usefully empty') };
    debug.enabled && debug(process.pid, '<14 worker:jsonCb#' + this.id, UTIL.stringify(message));
    cb(message, handle, exports.sent('onWorkerJson'));
});

worker.on('workerFlush', function onWorkerFlush(flush, handle) { // _this_ is worker
    debug.enabled && debug.apply(0, [process.pid, '>-- worker:flush#' + this.id].concat(argsMap(arguments)));
    var session = exports.sessions[flush.sid];
    if (!session)
        return console.log('Error: non existant session', flush.sid);
    for (var tag in exports.tags) // check the current set of tags
        if (exports.tags[tag] === session) // any tag referencing the session
            delete exports.tags[tag]; // remove that tag referencing the session
    session.enter(null);
});

worker.on('workerFetch', function onWorkerFetch(fetch, handle, cb) { // _this_ is worker
    debug.enabled && debug.apply(0, [process.pid, '>?? worker:fetch#' + this.id].concat(argsMap(arguments)));
    var reply = exports.sessions[fetch.sid] || { err: { name: 'Error', message: 'unknown session - ' + fetch.sid } };
    debug.enabled && debug(process.pid, '<?? worker:fetchCb#' + this.id, UTIL.stringify(reply));
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
    var match, session, matched, training, first, hex, cid = 'unmatched', communicatorName, req_params;
    if (match = onWorkerEslChannel.ree164.exec(evt.headers['Caller-Caller-ID-Number']))
        evt.headers['_e164'] = match[1];

    if (session = exports.tags[evt.headers['Unique-ID']]) // Communicator - existing session
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.tags[evt.headers['_e164']]) // Communicator - existing session
        matched = { '_e164': evt.headers['_e164'] };
    else if (session = exports.tags[evt.headers['Caller-Caller-ID-Number']]) // Communicator - existing session
        matched = { 'Caller-Caller-ID-Number': evt.headers['Caller-Caller-ID-Number'] };
    else if (session = exports.tags[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    else if (session = exports.trainings[evt.headers['Caller-Destination-Number']]) // cid in CLI training
        matched = training = { training: evt.headers['Caller-Destination-Number'] };

    !session && evt.type === 'CHANNEL_CREATE' && blankLine.test(exports.debug.names.join()) && console.log('-'.repeat(40)); // blank line
    if (evt.type !== 'CHANNEL_CREATE' || evt.headers['Call-Direction'] !== 'inbound') {
        null;
    } else if (evt.headers['Caller-Destination-Number']) { // inbound CHANNEL_CREATE
        if (evt.headers['Caller-Destination-Number'].startsWith('440000')) // ATA SIP call
            req_params = 'appello=scaber';
        else if (evt.headers['Caller-Destination-Number'].match(/^\+?\d+\D\d{4}$/)) // Genesys Grouped callback
            req_params = 'appello=scaber:callback';
    }

    if (hex = evt.headers['variable_sip_h_X-CDS-CallId'])
        cid = '#### ' + hex.match(/.{1,8}/g).map(x => parseInt(x, 16)).join('-') + ' H(' + hex + ')';
    else if (evt.headers['variable_sip_h_x-inin-cnv'])
        cid = '#### ' + evt.headers['variable_sip_h_x-inin-cnv'];
    else if (evt.headers['variable_sip_rh_x-inin-cnv'])
        cid = '#### ' + evt.headers['variable_sip_rh_x-inin-cnv'];

    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, matched && UTIL.stringify({ matched: matched }), cid);
    if (session || exports.retired || evt.type !== 'CHANNEL_CREATE' || evt.headers['Call-Direction'] !== 'inbound') {
        null; // ignore
    } else if (communicatorName = exports.getCommunicatorName(evt.headers['Caller-Destination-Number'])) { // SIP call to <protocol>@host
        if (communicatorName === 'scaip') // prevent SCAIP SIP CHANNEL_CREATE from spawning a Session
            esl.executeAsyncX('hangup', ['CHANNEL_UNACCEPTABLE'], evt.headers['Unique-ID']);
        else
            first = session = new main.modules.Session(evt, communicatorName); // (evt, 'communicatorName')
    } else if (!(match = (req_params || evt.headers['variable_sip_req_params'] || '').match(exports.appelloScaber)) // examine the INVITE request parameters
        && !(match = (evt.headers['variable_sip_user_agent'] || '').match(exports.uagentScaber)) // examine the user-agent
    ) { // PSTN call with appello=scaber parameter
        debug(' ' + process.pid, UTIL.stringify({
            req_params: req_params || evt.headers['variable_sip_req_params'],
            user_agent: evt.headers['variable_sip_user_agent']
        }));
    } else switch (match[1]) {
        case 'pnc':
            first = session = new main.modules.Session(evt, 'bs8521pnc', match[2]); // (evt, 'communicatorName', ?dialPrefix)
            break;

        case 'callback':
            first = session = new main.modules.Session(evt, 'callback'); // (evt, 'communicatorName')
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
    else if (session = exports.tags[evt.headers['Unique-ID']])
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.tags[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, evt.headers['Detected-Tone'], UTIL.stringify({ matched: matched }) || 'unmatched');
    session && session.signal(evt.type, evt, false);
    debug('-' + process.pid, evt.headers['Unique-ID'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslDtmf(evt, hdrs, body) {
    var hr = process.hrtime();
    esl.parseEvt.call(this, evt, hdrs, body);
    var now = new Date, matched, session;
    if (session = exports.tags[evt.headers['Unique-ID']])
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.tags[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, now, `${now-evt.when}ms`, evt.headers['DTMF-Digit'] + '@' + evt.headers['DTMF-Duration'], UTIL.stringify({ matched: matched }) || 'unmatched');
    session ? session.signal(evt.type, evt, false) : debug.enabled && debug(process.pid, 'tags:', UTIL.stringify(Object.keys(exports.tags)));
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
    else if (session = exports.tags[evt.headers['from_user']]) // Communicator - existing session
        matched = { 'from_user': evt.headers['from_user'] };
    else if (session = exports.tags[evt.headers['to_user']]) // Consumer - existing session
        matched = { 'to_user': evt.headers['to_user'] };
    !session && blankLine.test(exports.debug.names.join()) && console.log('-'.repeat(40)); // blank line
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'] || evt.headers['Event-Sequence'], evt.type, new Date, UTIL.stringify({ matched: matched }) || 'unmatched');
    if (exports.retired)
        hint = 'retired';
    else if (session)
        hint = 'existing';
    else if (!(evt.parsed || {}).mrq && !(evt.parsed || {}).ATM)
        hint = 'neither SCAIP nor NOWIP';
    else if (evt.parsed.mrq && (evt.headers['from_user'] !== evt.parsed.mrq.cid[0]))
        hint = 'scaip: from!cid ' + UTIL.stringify({ user: evt.headers['from_user'] || '', cid: evt.parsed.mrq.cid[0] || '', crd: evt.parsed.mrq.crd || [] });
    else if (evt.parsed.ATM && !['0', '1'].includes(evt.parsed.ATM.type[0]))
        hint = 'nowip: ignore spurious ACK';
    else if (communicatorName = exports.getCommunicatorName(evt.headers['to_user']))
        first = session = new main.modules.Session(evt, communicatorName);
    if (!session)
        return debug('-' + process.pid, evt.headers['Unique-ID'] || evt.headers['Event-Sequence'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms', hint);

    session.signal(evt.type, evt, !!first);
    debug('-' + process.pid, evt.headers['Unique-ID'] || evt.headers['Event-Sequence'], evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
}

function onWorkerEslInfo(evt, hdrs, body) {
    if ((evt.body || '').startsWith('Signal=')) // leave SIP-INFO:DTMF to be handled by onWorkerEslDtmf()
        return;

    var hr = process.hrtime();
    esl.parseEvt.call(this, evt, hdrs, body);
    var session, matched;
    if (session = exports.tags[evt.headers['Unique-ID']])
        matched = { 'Unique-ID': evt.headers['Unique-ID'] };
    else if (session = exports.tags[evt.headers['Other-Leg-Unique-ID']]) // Consumer - existing session
        matched = { 'Other-Leg-Unique-ID': evt.headers['Other-Leg-Unique-ID'] };
    else if (session = exports.sessions[evt.headers['variable_appello_unique']]) // Consumer - existing session
        matched = { 'variable_appello_unique': evt.headers['variable_appello_unique'] };
    debug.enabled && debug('+' + process.pid, evt.headers['Unique-ID'], evt.type, new Date, UTIL.stringify({ body: evt.body, matched: matched }) || 'unmatched');
    session ? session.signal(evt.type, evt, false) : debug.enabled && debug(process.pid, 'tags:', UTIL.stringify(Object.keys(exports.tags)));
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
                exports.uuid && rpscb.publish('bsia:receivers', { buid: exports.uuid, host: os.hostname(), hint: 'onWorkerEslCustom' });
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
        process.running.ready.then(function onWorkerReady() { // only announce takeover when completely ready for service
            var evt = new modesl.Event('CUSTOM', 'appello::scaber');
            debug(process.pid, 'eslReady: send:', exports.started);
            evt.addHeader('Scaber-Started', exports.started.toJSON());
            esl.sendEventX(evt, function (err) {
                err && console.log('onWorkerEslReady:', err);
            });
            exports.uuid || (exports.uuid = main.uuidv1());
            rpscb.on(`bsia:${exports.uuid}`, function onBsiaMessage(bsia, cb) {
                bsia.when = new Date;
                var hr = process.hrtime(), evt = { type: 'BSIA_DATA', headers: { from_user: bsia.account, to_user: bsia.host } };
                console.log('-'.repeat(40)); // blank line
                debug.enabled && debug('+' + process.pid, evt.type, new Date, UTIL.stringify(bsia));
                var session = new main.modules.Session(evt, 'null');
                Object.assign(session.payload, { protocol: 'BSIA', originUser: bsia.account, service: bsia.host, bsia: [bsia] });
                session.enter(null);
                cb(null, true);
                debug('-' + process.pid, evt.type, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms');
            });
            var host = os.hostname(), weight = ((main.secrets.bsia || {})[host] || {}).weight || 2;
            rpscb.on('bsia:bridges', function onBsiaBridges(receiver, cb) {
                debug.enabled && debug(process.pid, 'onBsiaBridges:', UTIL.stringify(Object.assign({ buid: exports.uuid, host: os.hostname() }, receiver)));
                cb(null, { buid: exports.uuid, host: host, weight: weight });
            });
            rpscb.publish('bsia:receivers', { buid: exports.uuid, host: host, weight: weight, hint: 'onWorkerReady' });
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
