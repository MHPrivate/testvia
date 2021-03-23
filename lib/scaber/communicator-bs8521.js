#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:bs8521');
var esl = require('../esl');
var main = require.main.exports;
var nowip = require('../nowip');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

var sends = {
    dataRequest:    'b@1000',
    acknowledge:    'b@80',
    speechReset:    'a30#@80',  // reset to default setting
    speechVolume1:  'a31#@80',  // volume level 1 (quiet preset)
    speechVolume2:  'a32#@80',  // volume level 2 (normal preset)
    speechVolume3:  'a33#@80',  // volume level 3 (loud preset)
    speechVolumeUp: 'a34#@80',  // volume up
    speechVolumeDn: 'a35#@80',  // volume down
    speechSpeaker1: 'a36#@80',  // select speaker 1
    speechSpeaker2: 'a37#@80',  // select speaker 2
    speechDuplex:   'a38#@80',  // switch to VOX mode
    speechSimplex:  'a39#@80',  // switch to simplex tone controlled (listen) mode
    pathSpeak:      'a@250+7@80',   // speak
    pathListen:     'a@250+8@80',   // listen
    pathClear:      'a@250+9@80',   // clear (clear speech)
    pathClose:      'a@250+d@80',   // clear down
    pathNull:       'a@250+#@80',   // null command (keepalive)
    selectUnit:     'a0%{0000}#',   // select local unit in grouped equipment
    catalogue:      'a1%{0000}#',   // list information on outstanding calls
};
module.exports = CommunicatorBs8521;

require('util').inherits(CommunicatorBs8521, require('../state-machine'));
function CommunicatorBs8521(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorBs8521 === false)
        throw new Error('Constructor CommunicatorBs8521 requires \'new\'');

    CommunicatorBs8521.super_.call(this, CommunicatorBs8521, {
        dataset: '',
        dtmfs: {}, // dictionary of phase dtmf accumulators
        interval: undefined, // reference to keepalive interval
        lastIndex: 0, // latest regexp lastIndex for A26H scan
        leaving: 0, // used to prevent recursive calls to state:leave method
        phase: undefined, // current dtmf phase
        retries: undefined, // persistent down-counter for speechDuplex resends (initially)
        session: session, // a reference to the owning session
        testing: 2,
        timeout: undefined, // timeout handle
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorBs8521, { // _this_ of all methods is the StateMachine instance
    A26H: /#A?(\d{26})#?/g, // regexp to scan BS8521 digits
    DS: /\bds=(\d+)\b/,     // regexp to retrieve the dataset from the REQUEST-URI
    a26Ms: 110,             // inter-digit delay when next expecting '#'
    dtmfMaxMs: 2500,        // max valid DTMF duration
    answerMs: 1300,         // post-answer delay to 1st data-request
    dataReqMs: 5000,        // repeat dataReq delay
    dumpMs: 10000,          // delay to forced hangup
    duplexMs: 1500,         // post dataAck delay to speechDuplex
    hashMs: NaN,            // special silence delay following a '#' digit
    silenceMs: 240,         // inter-digit timeout (180:360)

    enter: function onCommunicatorBs8521Enter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorBs8521Leave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.interval = worker.resetInterval(this.interval);
        this.timeout = worker.resetTimeout(this.timeout);
        this.session.signal('detached');
    },
    send: function onCommunicatorBs8521Send(cond, op, /* ..., */ cb) { // ?cond(), op, ?args..., ?cb(err)
        var args = Array.from(arguments);
        cond = typeof args[0] === 'function' ? args.shift() : undefined;
        op = args.shift();
        cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : undefined;
        debug(this.session.sid, 'send:', op, sends[op]);
        this.timeout = worker.resetTimeout(this.timeout);
        if (!op || !sends[op] || (cond && !cond.call(this)))
            return cb && cb(), this;

        switch (op) {
            case 'acknowledge':
                if (!this.dtmfs['speechDuplex'])
                    this.timeout = (this.retries = 3) && worker.resetTimeout(this.timeout, this.signal.bind(this, 'send', 'speechDuplex'), CommunicatorBs8521.duplexMs);
                break;

            case 'speechDuplex':
                (this.phase === op) || (this.dtmfs[this.phase = op] = '');
                this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'speechDuplexTimeout'), CommunicatorBs8521.duplexMs);
                break;

            default:
                (this.phase === op) || (this.dtmfs[this.phase = op] = '');
                break;
        }

        // ************** THESE ARE FOR TESTING PURPOSES ONLY AND SHOULD NOT BE HERE FOR LIVE **************
        //if (op === 'dataRequest') return console.log('*TEST-CODE* in onCommunicatorBs8521Send), cb && cb(); // for testing start_dtmf activation
        //if (op === 'acknowledge' && this.testing-- > 0) return console.log('*TEST-CODE* in onCommunicatorBs8521Send), cb && cb(); // for testing send-data repeats

        var sm = this;
        chain(cb || function cleanup(err, evt) {
            err && console.log(sm.session.sid, 'onCommunicatorBs8521Send:', err);
            ((evt || { body: '' }).body[0] === '-') && console.log(sm.session.sid, 'onCommunicatorBs8521Send:', evt.body.slice(0, -1));

        }, function () {
            debug(sm.session.sid, 'send:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.uuid, this); // dptools:unblock_dtmf doesn't work

        }, function () {
            var n = -1,
                dtmf = sends[op].replace(/%{(\d+)}/, function (match, digits) { // replace any %{n} with varargs
                    return (typeof args[++n] !== 'number') ? digits : ('0'.repeat(digits.length) + args[n]).slice(-digits.length);
                });
            debug(sm.session.sid, 'send:', 'send_dtmf', dtmf);
            esl.executeAsyncX('send_dtmf', [dtmf], sm.uuid, this);

        }, function () {
            debug(sm.session.sid, 'send:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.uuid, this); // dptools:unblock_dtmf doesn't work

        });
        return this;
    },
    clear: function onCommunicatorBs8521Clear(err, evt) {
        debug(this.session.sid, 'clear:', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        this.interval = worker.resetInterval(this.interval);
        this.signal('send', 'pathClose');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'release'), CommunicatorBs8521.dumpMs);
        return this;
    },
    release: function onCommunicatorBs8521Release() { // forced release timeout
        debug(this.session.sid, 'release:');
        this.timeout = worker.resetTimeout(this.timeout);
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'release:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    answer: function onCommunicatorScaipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        this.interval = worker.resetInterval(this.interval, this.signal.bind(this, 'send', 'pathNull'), 60000);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorBs8521ChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];
        var match = CommunicatorBs8521.DS.exec(evt.headers['variable_sip_req_params']);
        this.dataset = match ? match[1] : '';
        this.uuid = evt.headers['Unique-ID'];
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, evt.type + ':', err);

        }, function () {
            esl.executeAsyncX('multiset', ['drop_dtmf=true park_after_bridge=true'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE:', 'answer');
            esl.executeAsyncX('answer', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorBs8521Channel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        if (evt.type !== 'CHANNEL_ANSWER')
            return this;

        var cond = function () {
            return !this.dtmfs['dataRequest'];
        }.bind(this);
        var sm = this, retries = 3, inbandRetry = retries - 1;
        var cb = function onCommunicatorBs8521ChannelCb(err, evt) {
            err && console.log(sm.session.sid, 'onCommunicatorBs8521ChannelCb:', err);
            ((evt || { body: '' }).body[0] === '-') && console.log(sm.session.sid, 'onCommunicatorBs8521ChannelCb:', evt.body.slice(0, -1));

            debug.enabled && debug(this.session.sid, 'CHANNEL_:', JSON.stringify({ retries: retries, phase: this.phase, dtmf: this.dtmfs[this.phase] }));
            if (retries === inbandRetry) {
                debug(this.session.sid, 'CHANNEL_:', 'activating in-band DTMF detection');
                esl.executeAsyncX('start_dtmf', [], sm.uuid);
            }
            if (this.dtmfs['dataRequest']) // received some data - send no further 'dataRequest's
                null;
            else if (!retries--) // no further 'dataRequest' - schedule forced release
                this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'release'), CommunicatorBs8521.dumpMs);
            else // can send further 'dataRequest's - schedule the next one
                this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'send', cond, 'dataRequest', cb), CommunicatorBs8521.dataReqMs); // send Nth 'dataRequest' 5sec thereafter
        }.bind(this);
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'send', cond, 'dataRequest', cb), CommunicatorBs8521.answerMs); // send 1st 'dataRequest' 1sec after answer
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorBs8521ChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorBs8521Custom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorBs8521Tone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorBs8521Dtmf(evt, first) { // received BS8521 dtmf
        var match, timeoutMs, timeoutFn = function onCommunicatorBs8521DtmfTimeout() {
                debug(this.session.sid, 'dtmfTimeout:', this.phase, this.dtmfs[this.phase]);
                this.timeout = worker.resetTimeout(this.timeout);
                this.signal(this.phase + 'Timeout'); // e.g. 'dataRequestTimeout' or 'speechDuplexTimeout'
            }.bind(this);
        if (evt.headers['DTMF-Duration'] / 8 < CommunicatorBs8521.dtmfMaxMs)
            this.dtmfs[this.phase] += evt.headers['DTMF-Digit'];
        if (this.phase && this.phase !== 'speechDuplex') { // only set an inter-digit timeout if expecting DTMF other that speechDuplex-ack
            CommunicatorBs8521.A26H.lastIndex = this.lastIndex;
            if (this.phase === 'pathClose')
                timeoutMs = NaN; // don't change the timeout
            else if (this.dtmfs[this.phase].endsWith('#'))
                timeoutMs = CommunicatorBs8521.hashMs; // usually NaN
            else if (match = CommunicatorBs8521.A26H.exec(this.dtmfs[this.phase]))
                timeoutMs = CommunicatorBs8521.a26Ms; // usually 110
            else
                timeoutMs = CommunicatorBs8521.silenceMs; // usually 240
            isNaN(timeoutMs) || (this.timeout = worker.resetTimeout(this.timeout, timeoutFn, timeoutMs));
        }
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8), this.phase, this.dtmfs[this.phase], timeoutMs + 'ms');
        return this;
    },
    dataRequestTimeout: function onCommunicatorBs8521DataRequestTimeout() { // A CC TT GGGGGGGG RRRR EEE LL P SS XX #
        if (this.phase !== 'dataRequest')
            return;

        // ************** THESE ARE FOR TESTING PURPOSES ONLY AND SHOULD NOT BE HERE FOR LIVE **************
        //this.dtmfs[this.phase] = console.log('*TEST-CODE* in onCommunicatorBs8521DataRequestTimeout') || this.dtmfs[this.phase].replace(/^A0/, 'A1'); // deliberately invalidate the 1st set of NOWIP digits

        var parsed = {}, match;
        CommunicatorBs8521.A26H.lastIndex = this.lastIndex;
        while (match = CommunicatorBs8521.A26H.exec(this.dtmfs[this.phase])) // until verified, for-each matching segment
            if ((parsed = nowip.parse(match[1]) || {}).verified) // parse & validate the NOWIP digits
                break;
        this.lastIndex = CommunicatorBs8521.A26H.lastIndex;
        if (!parsed.verified)
            return this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'release'), CommunicatorBs8521.dumpMs);

        var lhdigits = this.session.context.lhdigits || '';
        parsed.$.speech = 1; // VOX
        parsed.$.controller = lhdigits + parsed.$.controller.slice(lhdigits.length);
        var data = nowip.stringify(parsed)
        Object.assign(this.session.payload, { ATM: { data: [data] } }, { originUser: data.slice(4, 16).replace(/^0+/, '') });
        this.signal('send', 'acknowledge');
    },
    speechDuplexTimeout: function onCommunicatorBs8521SpeechDuplexTimeout() {
        if (this.phase !== 'speechDuplex')
            return;

        if (/BB$/.test(this.dtmfs[this.phase])) // command has been ack'd twice
            return this.session.signal('consume', undefined);

        if (this.retries-- > 0) // further retries
            return this.signal('send', 'speechDuplex');

        this.signal('release');
    },
});
