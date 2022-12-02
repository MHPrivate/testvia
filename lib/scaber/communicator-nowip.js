#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    cluster = require('cluster'),
    debug = require('debug')('communicator:nowip'),
    esl = require('../esl'),
    js2xmlInfo = new (require('xml2js')).Builder({ renderOpts: null, xmldec: { encoding: 'UTF-8' } }),
    js2xmlMesg = new (require('xml2js')).Builder({ headless: true, renderOpts: null }),
    main = require.main.exports,
    nowip = require('../nowip'),
    worker = require('./worker'), // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }
    xml2js = require('xml2js');

process.on('sipMessagePreProcess', function onSipMessageProProcessNowip(evt) {
    var err, session, mandatory = new Set(['version', 'type', 'data', 'time', 'mac']); // each of these attributes must have content
    evt.parsed || xml2js.parseString(evt.body, function (err, js) {
        evt.parsed = Object.assign(err || js, { xml: evt.body });
    });
    (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
    if (err || !evt.parsed || !evt.parsed.ATM)
        return err && console.log('onSipMessageProProcessNowip:', err);

    mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.ATM || {});
    mandatory.size && (err = Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
    if (err)
        return console.log('onSipMessageProProcessNowip:', err);

    if (session = worker.tags[evt.headers['Unique-ID']]) // received via an active call-leg
        evt.scaber = { sid: session.sid };
});

require('util').inherits(module.exports = exports = CommunicatorNowip, require('../state-machine'));
function CommunicatorNowip(session, evt) {
    if (this instanceof CommunicatorNowip === false)
        throw new Error('Constructor CommunicatorNowip requires \'new\'');

    CommunicatorNowip.super_.call(this, CommunicatorNowip, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        msgEvt: undefined, // latest received MESSAGE
        released: undefined, // communicator released timestamp
        session: session, // a reference to the owning session
        timeout: undefined, // general timeout reference
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorNowip, {// _this_ of all methods is the StateMachine instance
    advisee: 1,         // luc
    messageMs: 6000,    // max time to wait for NOWIP message after proceeding

    enter: function onCommunicatorNowipEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorNowipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        this.session.signal('detached');
    },
    answer: function onCommunicatorNowipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', (this.session.firstEvt || {}).type, callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
        return this;
    },
    clear: function onCommunicatorNowipClear(err, evt) {
        debug.enabled && debug(this.session.sid, 'clear:', evt ? JSON.stringify(evt) : '', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'clear:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorNowipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        Object.assign(this.session.payload, {
            protocol: 'NOWIP',
            originUser: evt.headers['Caller-Caller-ID-Number'],
        });

        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'clear'), CommunicatorNowip.messageMs);
        this.session.signal('tag', [evt.headers['Caller-Caller-ID-Number']]); // expect SIP-MESSAGE from same origin as SIP-INVITE
        var sm = Object.assign(this, { uuid: evt.headers['Unique-ID'] });
        chain(null, function () {
            debug(sm.session.sid, 'send:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.uuid, this);

        }, function (evt) {
            esl.executeAsyncX('set', ['park_after_bridge=true'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'record_session', main.hack.record || false);
            if (!sm.session.context.record && !main.hack.record)
                return this();

            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'pre_answer');
            esl.executeAsyncX('pre_answer', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorNowipChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.advisees[exports.advisee] = this;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorNowipChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        this.session.advisees[exports.advisee] = undefined;
        this.released = new Date;
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorNowipCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorNowipTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorNowipDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorNowipMessage(evt, first) { // received NOWIP message
        evt.headers['Unique-ID'] || (evt.headers['Unique-ID'] = this.uuid); // needed for ex-Dialog NOWIP-rq to enable in-Dialog NOWIP-rp
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], evt.body);
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        var atm;
        if (!evt.parsed || evt.parsed.ATM.type[0] !== '1')
            null;
        else if (evt.parsed.ATM.data[0].length !== 24) // wrong length NOWIP data
            this.signal('clear');
        else if (this.session.payload.ATM) // abort if we've already handled a NOWIP message for this session
            this.signal('clear');
        else // all good so ACK the message
            esl.atm(this.msgEvt = evt, atm = { type: 'A' });
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], atm && atm.xml);
        if (!atm) // a NOWIP-ACK - stop here
            return this;

        var bs8521 = nowip.parse(evt.parsed.ATM.data[0]);
        Object.assign(this.session.payload, evt.parsed, {
            scheme: bs8521.$.controller,
            unit: bs8521.$.unit,
            originUser: (bs8521.$.controller + bs8521.$.unit).replace(/^0*/, '') || 0,
            event: bs8521.$.event,
            events: [
                bs8521.$.event + bs8521.$.status,
                bs8521.$.event + '**',
                '***' + bs8521.$.status,
            ],
            grouped: bs8521.grouped,
            location: bs8521.$.location,
            status: bs8521.$.status,
        }); // copies ATM
        this.session.signal('route');
        return this;
    },
    transaction: function onCommunicatorNowipTransaction(type, match, /* ..., cb */) { // consumer-to-communicator transaction
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
                        return this.signal('atmCommandControlRelease1');
                    case 'release2':
                        return this.signal('atmCommandControlRelease2');
                    case 'releaseKeysafe':
                        return this.signal('atmCommandControlRelease2');
                    case 'releaseAll':
                        return this.signal('atmCommandControlReleaseAll');
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
                        break;
                    case 'listen': // ack: B
                        break;
                    case 'clear': // status: A000000#
                        break;
                    case 'close': // ack: B
                        break;
                    case 'null': // ack: B ????
                        break;
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
                        break;
                    case 'volumeDn': // ack: B
                        break;
                    case 'speaker1': // ack: B
                        break;
                    case 'speaker2': // ack: B
                        break;
                    case 'duplex': // ack: B
                        break;
                    case 'simplex': // ack: B
                        break;
                }
                break;
        }
        debug.enabled && debug(this.session.sid, 'transaction:', JSON.stringify(argsMap(arguments)), 'UNIMPLEMENTED for protocol');
        return (Array.isArray(match) ? cb(null, '') : cb(null, '-UNIMPLEMENTED')) || this;
    },
    atmCommandControlRelease1: function onCommunicatorNowipControlRelease1() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlRelease1:', atm.xml);
        return this;
    },
    atmCommandControlRelease2: function onCommunicatorNowipControlRelease2() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlRelease2:', atm.xml);
        return this;
    },
    atmCommandControlReleaseKeysafe: function onCommunicatorNowipControlReleaseKeysafe() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlReleaseKeysafe:', atm.xml);
        return this;
    },
    atmCommandControlReleaseAll: function onCommunicatorNowipControlReleaseAll() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlReleaseAll:', atm.xml);
        return this;
    },
});
