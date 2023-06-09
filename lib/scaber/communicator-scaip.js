#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:scaip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }
var xml2js = require('xml2js');

require('util').inherits(module.exports = exports = function CommunicatorScaip(session, evt) {
    if (this instanceof exports === false)
        throw new Error('Constructor CommunicatorScaip requires \'new\'');

    exports.super_.call(this, exports, {
        answered: undefined,    // communicator answered timestamp
        callerId: undefined,    // only set where handling a long-lived MESSAGE (eg gsm:+372... OR sip:user@ip)
        clearOnAnswer: false,   // flag for truncate (a.k.a auto-answer)
        direction: undefined,   // tristate to track prevailing state (undefined, 'speak', 'listen')
        keepalive: undefined,   // reference to keepalive interval
        leaving: 0,             // used to prevent recursive calls to state:leave method
        released: undefined,    // communicator released timestamp
        session: session,       // a reference to the owning session
        speech: undefined,      // tristate to track prevailing state (undefined='simplex', 'duplex')
        timeout: undefined,     // reference to a call-arrival (60s) or clear-down(5s) timeout
        uuid: undefined,        // channel-id of inbound call
    }, evt);
}, require('../state-machine'));

process.on('sipMessagePreProcess', function onSipMessageProProcessScaip(evt) {
    var err, mandatory = new Set(['ref', 'cid', 'dty']); // each of these attributes must have content
    if (evt.headers['type'] !== 'application/scaip+xml')
        return;

    evt.parsed || xml2js.parseString(evt.body, function (err, js) {
        evt.parsed = Object.assign(err || js, { xml: evt.body });
    });
    (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
    if (err || !defaults(evt.parsed, 'mrq'))
        return err && console.log('onSipMessageProProcessScaip:', err);

    mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.mrq || {});
    mandatory.size && (err = Object.assign(new Error('invalid SCAIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
    if (err)
        return console.log('onSipMessageProProcessScaip:', err);

    evt.scaber = {
        origin: evt.headers['from_user'],
        unique: evt.parsed.mrq.ref[0],
    };
    evt.scaber.sid = '$' + evt.scaber.origin + '$' + evt.scaber.unique;
});

defaults.mrq = { // message-request defaults (when omitted)
    ame: ['0'],     // additional-message
    cha: ['0'],     // call-handling
    crd: ['sip:'],  // caller-id
    dte: [''],      // device-text (like user-agent)
    hbo: ['0'],     // heartbeat-options
    lco: ['0'],     // location-code
    mreq: ['0'],    // media-request
    mty: ['ME'],    // message-type
    pri: ['0'],     // priority
    sco: ['0'],     // system-config
    stc: ['10'],    // status-code
    ver: ['01.00'], // version
};

defaults.mrs = { // message-response defaults (when omitted)
    cve: ['01.00'], // common-version
    mre: ['0'],     // media-reply
    cre: ['61'],    // callhandling-reply
};

function defaults(parsed, type) {
    if (typeof parsed !== 'object' || typeof parsed[type] !== 'object')
        return;
    for (var key in defaults[type])
        if (!Array.isArray(parsed[type][key]) || !parsed[type][key].length)
            parsed[type][key] = defaults[type][key];
    return parsed;
}

Object.assign(exports, {// _this_ of all methods is the StateMachine instance
    advisee: 1,             // luc
    allowStcs: undefined && [9, 10, 16, 110, 123, 124],
    //blockStcs: [102, 113, 123],
    clearOnAnswerMs: 1000,
    closeDtmf: '0@200',
    defaults: defaults,
    duplexDtmf: '4@200',
    listenDtmf: '7@200',
    noCdrPI: true,
    releaseDtmf: '9@200',
    reCrd: /^([^:]+:).*/,   // no-voice: / gsm: / sip: / tel:
    routeMs: 3000,
    speakDtmf: '8@200',
    volDnDtmf: '1@200',
    volUpDtmf: '3@200',
    arcDtmf: { // permitted agent dtmf generation
        '1': '1@400',
        '2': '2@400',
        '3': '3@400',
        'A': null,
        '4': null,
        '5': '5@400',
        '6': '6@400',
        'B': null,
        '7': null,
        '8': null,
        '9': '9@400',
        'C': null,
        '*': null,
        '0': null,
        '#': null,
        'D': null,
    },

    enter: function onCommunicatorScaipEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorScaipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        this.keepalive = worker.resetInterval.call(this.session.sid, this.keepalive);
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        this.session.signal('detached');
    },
    clear: function onCommunicatorScaipClear(err, evt) {
        debug(this.session.sid, 'clear:', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        this.keepalive = worker.resetInterval.call(this.session.sid, this.keepalive);
        debug(this.session.sid, 'clear:', this.answered ? 'clear' : 'answer');
        if (this.answered) {
            this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'release'), 10000); // allow the scaip device upto 10s to disconnect
            worker.legDtmf(this, exports.closeDtmf, false, 'cls'); // allow+send
        } else if (this.clearOnAnswer = true) { // assign-test
            this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'answer'), exports.clearOnAnswerMs); // allow the scaip device upto 1s to settle
        }
        return this;
    },
    release: function onCommunicatorScaipRelease() { // forced release timeout
        debug(this.session.sid, 'release:');
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'release:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    answer: function onCommunicatorScaipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        if (!this.uuid)
            return this;

        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorScaipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];
        this.uuid = evt.headers['Unique-ID'];

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, evt.type + ':', err);
            debug(sm.session.sid, 'CHANNEL_CREATE:', 'answered');
            sm.timeout = worker.resetTimeout.call(sm.session.sid, sm.timeout, sm.session.signal.bind(sm.session, 'route'), exports.routeMs);

        }, function () {
            esl.executeAsyncX('set', ['park_after_bridge=true'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'record_session', main.hack.record || false);
            if (!sm.session.context.record && !main.hack.record)
                return this();

            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'block_dtmf');
            worker.legDtmf(sm, '', true, '?', this); // just block

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.3:', 'answer');
            esl.executeAsyncX('answer', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorScaipChannel(evt, first) {
        debug(this.session.sid, evt.type + ':');
        if (evt.type !== 'CHANNEL_ANSWER')
            return this;

        this.answered = new Date;
        this.session.advisees[exports.advisee] = this;
        if (this.clearOnAnswer)
            this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'clear'), exports.clearOnAnswerMs);
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorScaipChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:');
        this.session.advisees[exports.advisee] = undefined;
        this.released = new Date;
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorScaipCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorScaipTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorScaipDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorScaipMessage(evt, first) {
        debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], evt.body);
        var mrq = evt.parsed.mrq,
            mrs = evt.parsed.mrs = { ref: mrq.ref[0], snu: 99 }, // 99='undefined error'
            noCdr,
            stc = +mrq.stc[0],
            crds, // crds={no-voice:,gsm:,sip:,sip-pp:}
            event = ('0000' + mrq.dty[0]).slice(-4),
            location = ('000' + mrq.lco[0]).slice(-3),
            status = ('0000' + mrq.stc[0]).slice(-4);
        Object.assign(this.session.payload, evt.parsed, {
            protocol: 'SCAIP',
            originUser: evt.headers['from_user'],
            event: event,
            events: [
                event + status,
                event + '****',
                '****' + status,
            ],
            grouped: false,
            location: location,
            status: status,
        }); // copies mrq & mrs
        mrq.crd.forEach(function (crd, idx, arr) {
            (crd = crd.match(exports.reCrd)) && (this[crd[1]] = crd[0]); // e.g. { 'gsm:': 'gsm:+447802827727', 'sip:': 'sip:12345@a.b.c.d' }
        }, crds = {});
        switch (mrq.mty[0]) {
            case 'ME':// message - alarm notify
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && {}; // immediate cleanup
                else if (stc === 19) // 19='Cancel'
                    crds = Object.assign(mrs, { snu: 0 }) && {}; // immediate cleanup
                else if (exports.blockStcs && exports.blockStcs.includes(stc)) // typically 102='Test transmission, primary channel'
                    crds = Object.assign(mrs, { snu: 0 }) && {}; // immediate cleanup
                else if (exports.allowStcs && !exports.allowStcs.includes(stc)) // non-alarm, therefore non-call - simply acknowledge
                    crds = Object.assign(mrs, { snu: 0 }) && {}; // immediate cleanup
                else if (crds['tel:'] || crds['gsm:'] || crds['sip:']) // potential media-leg
                    Object.assign(mrs, { snu: 0, mre: 1, cre: 62 });
                else // no media-leg
                    Object.assign(mrs, { snu: 0 });
                break;

            case 'RE': // reset - alarm withdrawn
                noCdr = true; // prevent CDRs for alarm-resets
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && {}; // immediate cleanup
                else
                    crds = Object.assign(mrs, { snu: 0 }) && {};
                break;

            case 'IN':// information - alarm update
                Object.assign(this.session.payload, evt.parsed, {
                    event: event,
                    events: [
                        event + status,
                        event + '****',
                        '****' + status,
                    ],
                    grouped: false,
                    location: location,
                    status: status,
                }); // copies mrq & mrs
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && {}; // immediate cleanup
                else
                    Object.assign(mrs, { snu: 0 });
                break;

            case 'PI': // hearbeat
                noCdr = exports.noCdrPI; // prevent CDRs for keepalive-pings
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && {}; // immediate cleanup
                else
                    crds = Object.assign(mrs, { snu: 0 }) && {};
                break;

            default:
                console.log(UTIL.stringify(evt.parsed));
                crds = {};
                noCdr = true; // prevent CDRs for unknown message-types
                break;
        }

        //debug.enabled && debug(this.session.sid, evt.type + ':', UTIL.stringify({ mrs: mrs, crds: crds }));
        if (noCdr || this.callerId) { // non-call SCAIP message OR there's already an ongoing Alarm - e.g. PI while ongoing Alarm
            esl.mrs(evt, Object.assign(mrs, { mre: 0, cre: 0 })); // ensure we don't request another media-leg while one is ongoing
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], '---:', mrs.xml);
            if (this.callerId) // don't cleanup where there is an ongoing media-leg
                return this;

            this.session.payload.noCdr = noCdr; // cleanup without generating a CDR
            return this.enter(null) || this; // cleanup
        }

        this.tnu = [evt.headers['login'].replace('mod_sofia', evt.headers['to_user'])];
        if (+mrq.mreq[0] !== 4 && (this.callerId = crds['sip:'])) {
            this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.enter.bind(this, null), 60000); // exit Communicator unless call arrives within 60sec
            this.session.signal('tag', [evt.headers['from_user']]); // expect SIP-INVITE from same origin as SIP-MESSAGE (which is also the SCAIP.cid)
            Object.assign(mrs, { tnu: this.tnu });
            esl.mrs(evt, mrs); // expect a CHANNEL_CREATE
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], 'sip:', mrs.xml);
            return process.emit('routingLookup', this.session) || this; // do routingLookup while awaiting media-leg

        } else if (+mrq.mreq[0] !== 4 && (this.callerId = crds['tel:'] || crds['gsm:'])) {
            var sm = this;
            chain(function cleanup(err) {
                if (err)
                    console.log(sm.session.sid, 'onCommunicatorScaipMessage:', err) || sm.enter(null);
                debug(sm.session.sid, evt.type + ':', evt.headers['Event-Sequence'], 'gsm:', mrs.xml);
                mrs.snu ? sm.enter(null) : mrs.mre ? process.emit('routingLookup', sm.session) : undefined; // do routingLookup while awaiting media-leg

            }, function () {
                var tag = crds['tel:'] ? 'tel:' : 'gsm:';
                if (sm.session.context.trustCrd) // we should trust the gsm:+blahblah CLI rather database-training
                    tag = crds[tag];
                worker.scaipCid2Tnu(sm.session, tag, this); // when training - updates worker.trainings[e164] = session

            }, function (tnu) { // 'gsm:+e164'
                if (!tnu) // CLI is unknown AND we're not able to train - so cleanup
                    return esl.mrs(evt, Object.assign(mrs, { snu: 5, mre: 0, cre: 0 }), this);

                // CLI is known OR we're training
                sm.tnu.splice(0, main.hack.multiTnu ? 0 : sm.tnu.length, tnu); // multiple OR single <tnu> nodes (multiple not currently supported by Essence & Neat)
                Object.assign(mrs, { tnu: sm.tnu });
                sm.timeout = worker.resetTimeout.call(sm.session.sid, sm.timeout, sm.enter.bind(sm, null), 60000); // exit Communicator unless call arrives within 60sec
                esl.mrs(evt, mrs, this); // expect a CHANNEL_CREATE

            });
            return this;

        } else { // no-voice: OR unknown - proceed with the Consumer leg
            esl.mrs(evt, mrs);
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], '???:', mrs.xml);
            return this.session.signal('route') || this;

        }
    },
    transaction: function onCommunicatorDetectTransaction(type, match, /* ..., cb */) { // consumer-to-communicator transaction
        var cb = arguments[arguments.length - 1],
            ok = Array.isArray(match) ? cb : cb.bind(0, null, '+SUCCESS');
        if (!this.uuid)
            return (Array.isArray(match) ? cb(null, '') : cb(null, '-DISCONNECTED')) || this;

        switch (type) {
            case 'acknowledge': // ('acknowledge', match) - response for 'catalogue', 'program', 'select'
                return ok() || this;

            case 'catalogue': // ('catalogue', match, unit) - A000000000000#
                //Substate = exports.Catalogue; // coupled with Clear
                break;

            case 'command': // ('command', match, command)
                // non-bs8521 commands
                break;

            case 'control': // ('control', match, control) - control is a string
                switch (arguments[2]) {
                    case 'release1':
                    case 'release2':
                    case 'releaseKeysafe':
                    case 'releaseAll':
                        worker.legDtmf(this, exports.releaseDtmf, null, 'ctl', () => ok()); // allow+send+block
                        return this;
                    case 'undefined':
                    case 'relay1On':
                    case 'relay1Off':
                    case 'relay2On':
                    case 'relay2Off':
                    case 'switchLocal':
                    case 'switchARC':
                    case 'switchPerson':
                    case 'inactivityOn':
                    case 'inactivityOff':
                    case 'intruderOn':
                    case 'intruderOff':
                    case 'coldOn':
                    case 'coldOff':
                    case 'tempOn':
                    case 'tempOff':
                    case '+1hr':
                    case '-1hr':
                    case 'resetStatus':
                    case 'inactivity':
                    case 'systest':
                    case 'suspend':
                    case 'resume':
                    case 'exit':
                }
                break;

            case 'paramGet': // ('paramGet', match, param) - param is a string
                break;

            case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
                break;

            case 'program': // ('program', match, pin) - ignores ACK - pin is numeric
                break;

            case 'quick': // ('quick', match, quick) - quick is a string
                switch (arguments[2]) {
                    case 'speak': // ack: B
                        this.speech = undefined;
                        this.direction = 'speak';
                        worker.legDtmf(this, exports.speakDtmf, null, 'spk', () => ok()); // allow+send+bloc
                        return this;
                    case 'listen': // ack: B
                        this.speech = undefined;
                        this.direction = 'listen';
                        worker.legDtmf(this, exports.listenDtmf, null, 'lsn', () => ok()); // allow+send+block
                        return this;
                    case 'clear': // status: A000000#
                        break;
                    case 'close': // ack: B
                        worker.legDtmf(this, exports.closeDtmf, false, 'cls', () => ok()); // allow+send
                        return this;
                    case 'null': // ack: B ????
                        var dtmf = { duplex: exports.duplexDtmf, listen: exports.listenDtmf, speak: exports.speakDtmf }[this.speech || this.direction];
                        worker.legDtmf(this, dtmf || exports.duplexDtmf, null, 'nul', () => ok()); // allow+send+block
                        return this;
                }
                break;

            case 'select': // ('select', match, unit) - unit is numeric - A000000000000#
                break;

            case 'speech': // ('speech', match, speech) - speech is a string
                switch (arguments[2]) {
                    case 'reset': // ack: B
                        break;
                    case 'volume1': // ack: B
                        break;
                    case 'volume2': // ack: B
                        break;
                    case 'volume3': // ack: B
                        break;
                    case 'volumeUp': // ack: B
                        worker.legDtmf(this, exports.volUpDtmf, null, 'vUp', () => ok()); // allow+send+block
                        return this;
                    case 'volumeDn': // ack: B
                        worker.legDtmf(this, exports.volDnDtmf, null, 'vDn', () => ok()); // allow+send+block
                        return this;
                    case 'speaker1': // ack: B
                        break;
                    case 'speaker2': // ack: B
                        break;
                    case 'duplex': // ack: B
                        this.speech = 'duplex';
                        this.direction = undefined;
                        worker.legDtmf(this, exports.duplexDtmf, null, 'dpx', () => ok()); // allow+send+block
                        return this;
                    case 'simplex': // ack: B
                        this.speech = undefined;
                        this.direction = 'listen';
                        worker.legDtmf(this, exports.listenDtmf, null, 'spx', () => ok()); // allow+send+block
                        return this;
                }
                break;

            case 'dtmf':
                if (!this.session.context.passDtmf && exports.arcDtmf[arguments[2]]) {
                    worker.legDtmf(this, exports.arcDtmf[arguments[2]], null, 'dtm', () => ok()); // allow+send+block
                    return this;
                }
                break;
        }
        debug.enabled && debug(this.session.sid, 'transaction:', UTIL.stringify(argsMap(arguments)), 'UNIMPLEMENTED for protocol');
        return (Array.isArray(match) ? cb(null, '') : cb(null, '-UNIMPLEMENTED')) || this;
    },
});

/// heartbeats:
// essence:     <mrq><ref>00001A85</ref><cha>0</cha><mty>PI</mty><cid>26317</cid><dty>02</dty><did>00</did><crd>no-voice:</crd><stc>102</stc></mrq>
// possum:      <mrq><mty>PI</mty><ref>1998218577</ref><cid>10149471</cid><dty>2</dty></mrq>
// telealarm:   <mrq><ref>v6l7eiuzBTfybE7j</ref><cid>999998</cid><dty>0002</dty><mty>PI</mty><stc>0009</stc><lco>002</lco><crd>gsm:</crd><cha>0</cha></mrq>

/// alarms:
// essence:     <mrq><ref>00001883</ref><cha>0</cha><mty>ME</mty><cid>26317</cid><dty>02</dty><did>00</did><crd>gsm:+37284463906</crd><stc>010</stc></mrq>
// possum:      <mrq><ref>1193308443</ref><cid>10149471</cid><dty>3</dty><stc>10</stc><crd>gsm:</crd></mrq>
// possum:      <mrq><ref>1925996942</ref><cid>10149471</cid><dty>4</dty><stc>10</stc><crd>gsm:</crd></mrq>
// telealarm    <mrq><ref>lmepivnFqmI8Jvv1</ref><cid>999998</cid><dty>0002</dty><mty>ME</mty><stc>0067</stc><crd>gsm:</crd><cha>0</cha></mrq>
// telealarm    <mrq><ref>yhexGeV5E49zglfi</ref><cid>999998</cid><dty>0004</dty><mty>ME</mty><stc>0010</stc><lco>002</lco><crd>gsm:</crd><cha>0</cha></mrq>
// doro:        <mrq><ref>803137200003</ref><mty>ME</mty><cid> 8031372</cid><dty>0004</dty><stc>0010</stc><crd>gsm:+</crd></mrq>
