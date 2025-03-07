#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    debug = require('debug')('communicator:nowip'),
    esl = require('../esl'),
    main = require.main.exports,
    nowip = require('../nowip'),
    worker = require('./worker'), // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }
    xml2js = require('xml2js');

process.on('sipMessagePreProcess', function onSipMessagePreProcessNowip(evt) {
    var err, session, mandatory = new Set(['version', 'type', 'data', 'time', 'mac']); // each of these attributes must have content
    evt.parsed || xml2js.parseString(evt.body, function (err, js) {
        evt.parsed = Object.assign(err || js, { xml: evt.body });
    });
    (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
    if (err || !evt.parsed || !evt.parsed.ATM)
        return err && console.log('onSipMessagePreProcessNowip:', err);

    mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.ATM || {});
    mandatory.size && (err = Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
    if (err)
        return console.log('onSipMessagePreProcessNowip:', err);

    if (session = worker.tags[evt.headers['Unique-ID']]) // received via an active call-leg
        evt.scaber = { sid: session.sid };
});

var controlMap = {
    'release1': '01',
    'release2': '02',
    'releaseKeysafe': '03',
    'releaseAll': '04',
    'undefined': '05',
    'relay1On': '06',
    'relay1Off': '07',
    'relay2On': '08',
    'relay2Off': '09',
    'switchLocal': '10',
    'switchARC': '11',
    'switchPerson': '12',
    'inactivityOn': '13',
    'inactivityOff': '14',
    'intruderOn': '15',
    'intruderOff': '16',
    'coldOn': '17',
    'coldOff': '18',
    'tempOn': '19',
    'tempOff': '20',
    '+1hr': '21',
    '-1hr': '22',
    'resetStatus': '23',
    'inactivity': '24',
    'systest': '25',
    'suspend': '30',
    'resume': '31',
    'exit': '32',
};
var paramMap = {
    'none': '000', // Not available
    'arc1': '001', // Telephone number 1 (ARC)
    'arc2': '002', // Telephone number 2 (ARC)
    'arc3': '003', // Telephone number 3 (ARC)
    'arc4': '004', // Telephone number 4 (ARC)
    'person5': '005', // Telephne number 5 (personal recipient)
    'person6': '006', // Telephne number 6 (personal recipient)
    'person7': '007', // Telephne number 7 (personal recipient)
    'person8': '008', // Telephne number 8 (personal recipient)
    'sequence': '009', // Telephone dial sequence [nnnnnnnn] 1..8
    'redials': '010', // Redial attempts
    'preDelay': '011', // Pre-alarm condition [nn] 00..99
    'unitId1': '012', // Unit/scheme ID no. 1
    'unitId2': '013', // Unit/scheme ID no. 2
    'fast1': '014', // User fast dial telephone number 1
    'fast2': '015', // User fast dial telephone number 2
    'fast3': '016', // User fast dial telephone number 3
    'fast4': '017', // User fast dial telephone number 4
    'pin': '018', // Programming mode security code [nnnn]
    'loudspeaker': '019', // Loudspeaker [nn] 00=off/01=on
    'speech': '020', // Default speech type setting [nn] 00=duplex/01=simplex
    'autoAnswer': '021', // Auto answer setting [nn] 00=off/01=on
    'intruderDelay': '022', // Intruder alarm entry/exit delay [nn] 00..99 seconds
    'reassuranceTone': '023', // Reassurance tone [nn] 00=off/01=on
    'dialMode': '024', // Dial mode [nn] 00=dtmf/01=loop-disconnect
    'datetime': '025', // Set real time clock [YYYYMMDDhhmm]
    'phoneWarning': '026', // Telephone line disconnect warning [nn] 00=off/01=on
    'mainsWarning': '027', // Mains power fail warning [nn] 00=off/01=on
    'periodicDays': '028', // Periodic test call [00] 00..99 days
    'awayMode': '029', // Away mode [nn] 00=off/01=on
    'systemType': '030', // System type [nn] see BS8521
    'equipmentId': '031', // Equipment-specific identifier
};
var quickMap = {
    'speak': '7',
    'listen': '8',
    'clear': '9',
    'close': 'D',
    //'null': '#',
};
var speechMap = {
    'reset': '0',
    'volume1': '1',
    'volume2': '2',
    'volume3': '3',
    'volumeUp': '4',
    'volumeDn': '5',
    'speaker1': '6',
    'speaker2': '7',
    'duplex': '8',
    'simplex': '9',
};
require('util').inherits(module.exports = exports = CommunicatorNowip, require('../state-machine'));
function CommunicatorNowip(session, evt) {
    if (this instanceof CommunicatorNowip === false)
        throw new Error('Constructor CommunicatorNowip requires \'new\'');

    CommunicatorNowip.super_.call(this, CommunicatorNowip, {
        grouped: undefined,     // placeholder for grouped object - set/updated by received Alarm message
        leaving: 0,             // used to prevent recursive calls to state:leave method
        programming: false,     // in programming mode
        released: undefined,    // communicator released timestamp
        responseCb: undefined,  // named function for command/program response (catalogueCb/selectCb/clearCb/closeCb/programCb)
        selected: null,         // track which unit is selected - updated by select-response
        session: session,       // a reference to the owning session
        timeout: undefined,     // general timeout reference
        uuid: undefined,        // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorNowip, {// _this_ of all methods is the StateMachine instance
    advisee: 1,         // luc
    messageMs: 6000,    // max time to wait for NOWIP message after proceeding
    catalogueMs: 5000,
    controlMs: 500,
    paramGetMs: 1000,
    paramSetMs: 1000,
    programMs: 500,
    quickMs: 500,
    selectMs: 1000,
    speechMs: 500,
    arcDtmf: { // permitted agent dtmf generation
        '1': '1@400', '2': '2@400', '3': '3@400', 'A': 'A@400',
        '4': '4@400', '5': '5@400', '6': '6@400', 'B': 'B@400',
        '7': '7@400', '8': '8@400', '9': '9@400', 'C': 'C@400',
        '*': '*@400', '0': '0@400', '#': '#@400', 'D': 'D@400',
    },

    enter: function onCommunicatorNowipEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorNowipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        if (this.uuid && !this.released) {
            debug(this.session.sid, 'leave:', 'hangup', this.uuid);
            esl.executeAsyncX('hangup', [], this.uuid);
        }
        this.session.signal('detached');
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
    },
    release: function onCommunicatorNowipRelease() { // forced release timeout - from close/closed/establish
        debug(this.session.sid, 'release:');
        if (!this.uuid)
            return this.enter(null) || this;

        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    close: function onCommunicatorDetectClose() { // from clear/cleared/catalogued
        debug(this.session.sid, 'close:');
        if (!this.session.payload.ATM || !this.signal('transaction', 'quick', {}, 'close'))
            return this.signal('release');

        return this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.closeMs || 5000);
    },
    clear: function onCommunicatorNowipClear() {
        debug(this.session.sid, 'clear:');
        if (!this.grouped || !this.selected)
            return this.signal('close');

        this.signal('transaction', 'quick', {}, 'clear');
        return this;

    },
    answer: function onCommunicatorNowipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', (this.session.firstEvt || {}).type, callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
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
        this.uuid && esl.executeAsyncX('hangup', [], this.uuid); // discard a stale aleg
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
        var atm,
            bs8521,
            responseCb;
        if (!evt.parsed)
            null;
        else switch (((evt.parsed.ATM || {}).type || [])[0]) {
            case 'A': // Acknowledgement
                bs8521 = true;
                responseCb = this.responseCb;
                this.responseCb = undefined;
                responseCb && responseCb.call(this, null, evt.parsed.ATM.type[0], evt.parsed.ATM.data[0]);
                break;

            case '0': // Heartbeat - needs ACK
                esl.atm(this.session.firstEvt, atm = { type: 'A' });
                break; // bs8521===undefined causes cleanup

            case '1': // Alarm - needs ACK - then grouped-select OR disperse-route
                this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
                if (evt.parsed.ATM.data[0].length !== 24
                    || !(bs8521 = nowip.parse(evt.parsed.ATM.data[0])))
                    break;
                esl.atm(this.session.firstEvt, atm = { type: 'A' });
                Object.assign(this, { grouped: bs8521.grouped ? { unit: bs8521.unit } : undefined, hvs: bs8521.$.speech === 1 });
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
                if (this.uuid && bs8521.grouped) // media-leg AND grouped
                    this.signal('transaction', 'select', {}, +bs8521.unit);
                else // dispersed
                    this.session.signal('route');
                break;

            case '5': // Command-rejected - catalogue/select/program
            case '6': // Command-busy - select
            case '7': // Command-response - select/control/clear/close
                responseCb = this.responseCb;
                this.responseCb = undefined;
                this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
                responseCb && responseCb.call(this, null, evt.parsed.ATM.type[0], evt.parsed.ATM.data[0]);
                bs8521=true;
                break; // bs8521===undefined causes cleanup
            case '9': // Program-response - paramGet/paramSet
                responseCb = this.responseCb;
                this.responseCb = undefined;
                this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
                responseCb && responseCb.call(this, null, evt.parsed.ATM.type[0], evt.parsed.ATM.data[0]);
                break; // bs8521===undefined causes cleanup

        }
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], atm && atm.xml);
        return !bs8521 ? this.enter(null) || this : this;
    },
    atmResponder: function onCommunicatorNowipAtmResponder(timeoutMs, responseCb) {
        if ((this.responseCb = responseCb) && timeoutMs)
            this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'transaction'), timeoutMs);
        return this;
    },
    transaction: function onCommunicatorNowipTransaction(type, match, arg2, arg3, arg4/* ..., cb */) { // consumer-to-communicator transaction
        debug.enabled && debug(this.session.sid, 'transaction:', argsMap(arguments));
        var args = Array.from(arguments),
            atm,
            cb = (typeof args[args.length - 1] === 'function') && args.pop(), // only defined for consumer-transaction
            ko = cb && (Array.isArray(match) ? cb.bind(0, null, '') : cb.bind(0, null, '-FAIL')), // only defined for consumer-transaction
            ok = cb && (Array.isArray(match) ? cb.bind(0, null) : cb.bind(0, null, '+SUCCESS')), // only defined for consumer-transaction
            bs8521,
            responseCb;
        if (!this.uuid) {
            cb && (Array.isArray(match) ? cb(null, '') : cb(null, '-DISCONNECTED'));
            return this;
        }

        if (!arguments.length && this.responseCb) { // cleanup any expired transaction
            responseCb = this.responseCb;
            this.responseCb = undefined;
            responseCb(new Error(`ExpiredError(${responseCb.name})`));
        }
        if (this.responseCb) {
            cb && (Array.isArray(match) ? cb(null, '') : cb(null, '-BUSY'));
            return this;
        }

        switch (type) {
            case undefined: // benign transaction to cleanup any outstanding responses
                return this;

            case 'acknowledge': // ('acknowledge', match) - response for 'catalogue', 'program', 'select'
                ok && ok();
                return this;

            case 'catalogue': // ('catalogue', match, unit) - A000000000000#
                if (!isNaN(arg2) || this.programming || !this.grouped)
                    break;
                esl.atm(this.session.firstEvt, atm = { type: '2', data: '10000' }); // single item catalogue only
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.catalogueMs, function catalogueCb(err, type, data) { // _this_ is this communicator
                    if (err || !['5', '6', '7'].includes(type)) // rejected/busy/success
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionCatalogueCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionCatalogueCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.catsel);
                    esl.atm(this.session.firstEvt, atm = { type: 'A', }); // acknowledge
                    debug(this.session.sid, 'onCommunicatorNowipTransactionCatalogueCb:', atm.xml);

                    if (cb) // consumer-transaction
                        return bs8521 ? ok(data) : ko(data);

                    if (bs8521) // automation
                        +bs8521.unit ? this.signal('transaction', 'select', {}, +bs8521.unit) : this.signal('close');
                }.bind(this));

            case 'command': // ('command', match, command)
                // non-bs8521 commands
                break;

            case 'control': // ('control', match, control) - control is a string
                if (!controlMap[arg2])
                    break;
                esl.atm(this.session.firstEvt, atm = { type: '2', data: '200' + controlMap[arg2] });
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.controlMs, function controlCb(err, type, data) { // _this_ is this communicator
                    if (err || !['5', '6', '7', 'A'].includes(type)) // rejected/busy/success/acknowledgement
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionControlCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionControlCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.control);
                    if (cb) // consumer-transaction
                        return bs8521 ? ok(data) : ko(data);
                }.bind(this));

            case 'paramGet': // ('paramGet', match, param) - param is a string
                if (!paramMap[arg2] || !this.programming)
                    break;
                esl.atm(this.session.firstEvt, atm = { type: '8', data: '500' + paramMap[arg2] });
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.paramGetMs, function paramGetCb(err, type, data) { // _this_ is this communicator
                    if (err || !['9'].includes(type)) // reponse
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionParamGetCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionParamGetCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.paramget);
                    if (cb) // consumer-transaction
                        return (bs8521 || {}).parameter ? ok(data) : ko(data);
                }.bind(this));

            case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
                if (!paramMap[arg2] || !this.programming)
                    break;
                arg3 = (arg3 || '').slice(0, 391);
                esl.atm(this.session.firstEvt, atm = { type: '8', data: '400' + paramMap[arg2] + ('000' + arg3.length).slice(-3) + arg3 });
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.paramSetMs, function paramSetCb(err, type, data) { // _this_ is this communicator
                    if (err || !['9'].includes(type)) // reponse
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionParamSetCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionParamSetCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.paramget);
                    if (cb) // consumer-transaction
                        (bs8521 || {}).parameter ? ok(data) : ko(data);
                }.bind(this));

            case 'program': // ('program', match, pin) - ignores ACK - pin is numeric
                if (isNaN(arg2))
                    break;
                esl.atm(this.session.firstEvt, atm = { type: 2, data: 'C' + ('0000' + arg2).slice(-4) });
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.programMs, function programCb(err, type, data) { // _this_ is this communicator
                    if (err || !['5', '6', '7', 'A'].includes(type)) // rejected/busy/success/acknowledgement
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionProgramCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionProgramCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.control);
                    if (cb) // consumer-transaction
                        return bs8521 ? ok(data) : ko(data);
                }.bind(this));

            case 'quick': // ('quick', match, quick) - quick is a string
                if (!quickMap[arg2])
                    break;
                esl.atm(this.session.firstEvt, atm = { type: '2', data: quickMap[arg2] });
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.quickMs, function quickCb(err, type, data) { // _this_ is this communicator
                    if (err || !['5', '6', '7', 'A'].includes(type)) // rejected/busy/success/acknowledgement
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionQuickCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionQuickCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.control);
                    if (cb) // consumer-transaction
                        return data !== '99999' ? ok(data) : ko(data);
                }.bind(this));

            case 'select': // ('select', match, unit) - unit is numeric - A000000000000#
                if (isNaN(arg2) || this.programming || !this.grouped)
                    break;
                esl.atm(this.session.firstEvt, atm = { type: 2, data: '0' + ('0000' + arg2).slice(-4) });
                debug(this.session.sid, `${type}.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.selectMs, function selectCb(err, type, data) { // _this_ is this communicator
                    if (err || !['5', '6', '7', 'A'].includes(type)) // rejected/busy/success/acknowledgement
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionSelectCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionSelectCb:', data);
                    bs8521 = nowip.parse(data, nowip.parse.catsel);
                    this.selected = bs8521 ? bs8521.unit : null;
                    if (cb) // consumer-transaction
                        return bs8521 ? ok(data) : ko(data);

                    // automation
                    Object.assign(this.payload.bs8521, bs8521);
                    this.session.signal('unroute') && this.session.signal('route');
                }.bind(this));

            case 'speech': // ('speech', match, speech) - speech is a string
                if (!speechMap[arg2])
                    break;
                esl.atm(this.session.firstEvt, atm = { type: '2', data: '3' + speechMap[arg2] });
                debug(this.session.sid, `speech.${arg2}`, atm.xml);
                return this.signal('atmResponder', exports.speechMs, function speechCb(err, type, data) { // _this_ is this communicator
                    if (err || !['5', '6', '7', 'A'].includes(type)) // rejected/busy/success/acknowledgement
                        return cb ? ko() : console.log(this.session.sid, 'onCommunicatorNowipTransactionSpeechCb:', err || type);

                    debug(this.session.sid, 'onCommunicatorNowipTransactionSpeechCb:', data);
                    if (cb) // consumer-transaction
                        return ok(data);
                }.bind(this));

            case 'dtmf':
                if (!this.session.context.passDtmf && exports.arcDtmf[arguments[2]]) {
                    worker.legDtmf(this, exports.arcDtmf[arguments[2]], null, 'dtm', () => ok()); // allow+send+block
                    return this;
                }
                break;
        }
        debug.enabled && debug(this.session.sid, 'transaction:', UTIL.stringify(argsMap(arguments)), 'UNIMPLEMENTED for protocol');
        cb && (Array.isArray(match) ? cb(null, '') : cb(null, '-UNIMPLEMENTED'));
        return this;
    },
    atmCommandControlRelease1: function onCommunicatorNowipControlRelease1() {
        return this.signal('transaction', 'control', {}, 'release1') || this;
    },
    atmCommandControlRelease2: function onCommunicatorNowipControlRelease2() {
        return this.signal('transaction', 'control', {}, 'release2') || this;
    },
    atmCommandControlReleaseKeysafe: function onCommunicatorNowipControlReleaseKeysafe() {
        return this.signal('transaction', 'control', {}, 'releaseKeysafe') || this;
    },
    atmCommandControlReleaseAll: function onCommunicatorNowipControlReleaseAll() {
        return this.signal('transaction', 'control', {}, 'releaseAll') || this;
    },
});
