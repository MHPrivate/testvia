#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('consumer:bs8521:pnc');
var esl = require('../esl');
var js2xml = new (require('xml2js')).Builder({ headless: true, renderOpts: null });
var main = require.main.exports;
var mysql = require('../mysql');
var nowip = require('../nowip');
var StateMachine = require('../state-machine');
var transform = require('./transform');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = ConsumerBs8521Pnc;

require('util').inherits(ConsumerBs8521Pnc, StateMachine);
function ConsumerBs8521Pnc(session, uris) {
    if (this instanceof ConsumerBs8521Pnc === false)
        throw new Error('Constructor ConsumerBs8521Pnc requires \'new\'');

    ConsumerBs8521Pnc.super_.call(this, ConsumerBs8521Pnc, {
        attempts: ConsumerBs8521Pnc.attempts, // initialised from Class
        bs8521: undefined,          // module variation of base value
        e164: session.context.e164 || worker.e164, // caller CLI on outbound calls
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        session: session,           // a reference to the owning session
        substates: Object.assign([], { _: undefined }), // chronology of past substates (attr:_ is current substate)
        success: false,             // flag indicating the consumer leg concluded successfully
        timeout: undefined,         // timeout handle
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuid: undefined,            // current consumer-leg uuid
        uuids: {},                  // { uuid: boolean } collection of active outbound channel-ids
    });
}

Object.assign(ConsumerBs8521Pnc, {// _this_ of all methods is the StateMachine instance
    Establish: Establish,           // StateMachine
    Commands: Commands,             // StateMachine
    attempts: 4,                    // max outbound call attempts
    attemptMs: 1000,                // delay between outbound attempts
    closeMs: 500,                   // hangup delay after close command
    nullMs: 130000,                 // max idle time before abandon
    testing: { 2: 'A' , 5: 'B', 8: 'C', 0: 'D', '*': 'a', '#': 'b' }, // test mappings when longer that 237ms

    enter: function onConsumerBs8521PncEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerBs8521PncLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:', this.success ? 'success' : 'retry');
        this.timeout = worker.resetTimeout(this.timeout);
        if (this.substates._) // active substate need archiving
            this.substates._ = this.substates.push(this.substates._) && undefined;
        for (var i = 0; i < this.substates.length; i++) // ensure all substates are exited
            this.substates[i].enter(null);
        for (var uuid in this.uuids) {
            if (!this.uuids[uuid])
                continue;
            debug(this.session.sid, 'leave:', 'hangup', uuid);
            esl.executeAsyncX('hangup', [], uuid);
        }
    },
    activate: function onConsumerBs8521PncActivate() { // multiple activations by session each time round the list of consumers
        debug.enabled && debug(this.session.sid, 'activate:', JSON.stringify(this.uris), callsites()[2].toString());
        if (!this.e164) { // must have a caller CLI
            if (debug.enabled)
                debug(this.session.sid, 'activate:', 'Error: caller CLI required')
            else
                console.log(this.session.sid, 'onConsumerBs8521PncActivate-Error: source CLI required');
            return this.session.signal('consume', false);
        }

        if (Array.isArray(this.uris)) { // convert array of {scheme,user,password,host,port,params,headers} to dialstring
            if (this.constructor.name in main.state) // rotate the available URIs according to the count of invokations
                this.uris.push.apply(this.uris, this.uris.splice(0, ++main.state[this.constructor.name] % this.uris.length));
            else // initialise the count of invokations
                main.state[this.constructor.name] = 0;
            this.uris = esl.dialstring(this.uris);
        }
        if (!this.uris) { // no available destination URIs
            if (debug.enabled)
                debug(this.session.sid, 'activate:', this.uris, callsites()[2].toString());
            else
                console.log(this.session.sid, 'onConsumerBs8521PncActivate-Error:  target URI(s) required');
            return this.session.signal('consume', false);
        }

        var sm = Object.assign(this, { attempts: ConsumerBs8521Pnc.attempts, success: false});
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, 'onConsumerBs8521PncOriginate:', err);
            sm.signal('originate');

        }, function () {
            this.index = sm.session.sid; // enable transform to tag mysql transactions
            transform.atm.call(sm.session, sm.session.payload, this); // provide session as _this_

        }, function (payload) {
            if (sm.session.payload.ATM)
                sm.bs8521 = nowip.parse(sm.session.payload.ATM.data[0]);
            else // typically an assist call
                sm.bs8521 = nowip.parse(nowip.stringify({}));

            if (sm.session.context.lhdigits) {
                sm.bs8521.controllerunit = sm.session.context.lhdigits.slice(0, 12);
                if (sm.bs8521.controllerunit.length < 12)
                    sm.bs8521.controllerunit += sm.session.payload.originUser.slice(sm.bs8521.controllerunit.length - 12);
            }
            sm.bs8521.$.system = 1; // Grouped equipment with supervisor off duty
            sm.bs8521.raw = nowip.stringify(sm.bs8521, undefined, true); // construnct BS8521 digits including checksum

            debug(sm.session.sid, 'activate:', 'rename recording to append NOWIP', sm.bs8521.raw.slice(0, -2));
            esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} ' + sm.bs8521.raw.slice(0, -2)], sm.session.communicator.uuid, this);

        });
        return this;
    },
    originate: function () {
        debug(this.session.sid, 'originate:', this.attempts, this.uris);
        if (!this.attempts--)
            return this.session.signal('consume', false);

        esl.bgapiX('originate', [esl.nvp({
            //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
            appello_consumer: !undefined, // true as we are a consumer leg
            appello_unique: this.session.unique,
            //drop_dtmf: true,
            //fs_send_unsupported_message: true, // enables uuid_send_message
            originate_continue_on_timeout: true,
            originate_timeout: 15,
            //origination_caller_id_name: '_undef_',
            origination_caller_id_number: '+' + this.e164,
            //origination_privacy: 'screen:hide_number',
        }, '{}' + this.uris), '&park'], this.signal.bind(this, 'originated'));
    },
    originated: function onConsumerBs8521PncParked(err, evt) { // originate has completed
        err && console.log(this.session.sid, 'onConsumerBs8521PncOriginated:', err);
        debug(this.session.sid, 'parked:', evt && evt.body.replace(/\s+$/, ''));
        var match = evt && evt.body.match(/^\+OK\s+([-\w]+)/);
        if (!match) // ultimately unsuccessful
            return this.signal('cleanup', false) || this;

        return this;
    },
    cleanup: function onConsumerBs8521PncCleanup(success) { // originate-fail, establish-fail, bridge-fail, CHANNEL_DESTROY
        debug(this.session.sid, 'cleanup:', success ? 'success' : 'retry', callsites()[2].toString());
        this.success || (this.success = success);
        var legs = 0;
        for (var uuid in this.uuids)
            if (this.uuids[uuid]) {
                legs++;
                debug(this.session.sid, 'cleanup:', 'hangup', uuid);
                esl.executeAsyncX('hangup', [], uuid);
            }
        if (legs) // await CHANNEL_DESTROY from remaining legs
            null;
        else if (this.success) // successful Consumer outcome
            this.session.signal('consume', true); // try next consumer OR task;
        else // attempt another originate
            this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'originate'), ConsumerBs8521Pnc.attemptMs);
        return this;
    },
    answered: function onConsumerBs8521PncAnswered() { // CHANNEL_ANSWER
        debug(this.session.sid, 'answered:');
        this.signal('substate', Establish, 'establish', this.bs8521.raw);
    },
    establish: function onConsumerBs8521PncEstablish(acknowledged) { // Substate-Establish
        debug(this.session.sid, 'establish:', acknowledged ? 'acknowledged' : 'retry');
        if (!acknowledged)
            return this.signal('cleanup', false) || this;

        debug(this.session.sid, 'bridge:', this.uuid, this.session.communicator.uuid);
        esl.executeAsyncX('eval', ['${uuid_bridge ${uuid} ' + this.session.communicator.uuid + '}'], this.uuid, this.signal.bind(this, 'bridged'));

    },
    bridged: function onConsumerBs8521PncBridged(err, evt) {
        err && console.log(this.session.sid, 'onConsumerBs8521PncBridged:', err);
        debug(this.session.sid, 'bridged:', evt && evt.headers['Application-Data'].replace(/\s+$/, ''));
        if (!evt && evt.headers['Application-Data'].startsWith('+OK')) // ultimately unsuccessful
            return this.signal('cleanup', false) || this;

        this.signal('substate', Commands, 'cleanup');
        return this;
    },
    substate: function onConsumerBs8521PncSubstate(Substate, signal, arg) { // helper to activate a new Substate
        var sm = Substate && Substate.super_;
        if (Substate) {
            while (sm && sm != StateMachine)
                sm = sm.super_;
            if (!sm) // does not inherit from StateMachine
                throw new Error('Substate must be an instance of StateMachine');
        }

        debug(this.session.sid, 'substate:', Substate && Substate.name);
        if (sm = this.substates._) // extisting substate assignment test
            this.substates.push(this.substates._) && sm.enter(this.substates._ = null);
        this.substates._ = Substate && new Substate(this, this.signal.bind(this, signal), arg);
    },
    CHANNEL_CREATE: function onConsumerBs8521PncChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[this.uuid = evt.headers['Unique-ID']] = true;
        this.session.signal('route', [this.uuid]);
        return this;
    },
    CHANNEL_: function onConsumerBs8521PncChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':');
        if (evt.type === 'CHANNEL_ANSWER')
            this.signal('answered');
        return this;
    },
    CHANNEL_DESTROY: function onConsumerBs8521PncChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], this.success ? 'success' : 'retry');
        this.uuids[evt.headers['Unique-ID']] = false;
        if (evt.headers['Unique-ID'] === this.uuid)
            this.signal('substate', undefined) // abandon substate processing

        var legs = 0;
        for (var uuid in this.uuids)
            legs += this.uuids[uuid];
        if (!legs) // all legs cleaned-up
            this.signal('cleanup', false); // try next consumer OR task;
        return this;
    },
    CUSTOM: function onCommunicatorBs8521PncCustom(evt, first) {
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorBs8521PncTone(evt, first) {
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorBs8521PncDtmf(evt, first) {
        var durationMs = evt.headers['DTMF-Duration'] / 8; // convert 8khz samples to msec
        switch (evt.headers['DTMF-Digit']) {
            case 'A':
                if (durationMs > 200)
                    evt.headers['DTMF-Digit'] = 'a';
                break;
            case 'B':
                if (durationMs > 500)
                    evt.headers['DTMF-Digit'] = 'b';
                break;
        }
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + evt.headers['DTMF-Duration']);
        return this;
    },
    MESSAGE: function onConsumerBs8521PncMessage(evt, first) { // received NOWIP ack
        debug(this.session.sid, 'MESSAGE:', evt.body);
        return this;
    },
});

//==================================================
require('util').inherits(Establish, StateMachine);
function Establish(consumer, next, data26) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', 'ConsumerBs8521Pnc:Establish requires \'new\'');

    Establish.super_.call(this, Establish, {
        acknowledged: false,        // flag indicating the data has been acknowledged
        consumer: consumer,         // reference to parent state-machine
        dataDtmf: Establish.dataDtmf.replace('26', data26), // candidate A26# data to send
        dataTries: Establish.dataTries, // initialised from the Class
        guardTries: Establish.guardTries, // initialised from the Class
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        next: next,                 // callback to signal State complete
        sent: false,                // flag indicating whether the data has been sent
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, {
    dataMs: (160 * 28) + 700,       // delay between repeat data28 sequence
    dataTries: 4,                   // attempts to send the A26#
    dataDtmf: 'A26#@80',            // base DTMF - '26' will be replaced
    guardMs: 3000,                  // delay between repeat guard tones
    guardTone: '%(250,0,1850)',     // guard-tone to send periodically
    guardTries: 10,                 // number of guard-tones to send
    initialMs: 10000,               // delay to 1st guard tone

    enter: function () {
        debug(this.consumer.session.sid, 'Establish.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'sendGuard'), Establish.initialMs);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.consumer.session.sid, 'Establish.leave:', this.consumer.substates._ === this ? 'active' : 'inactive');
        this.timeout = worker.resetTimeout(this.timeout);
        if (this.consumer.substates._ === this) // confirm we are the active substate
            this.next && this.next(this.acknowledged);
    },
    sendGuard: function () {
        if (!this.guardTries)
            return this.enter(null);

        debug(this.consumer.session.sid, 'Establish.guard:', this.guardTries--, 'gentones', Establish.guardTone);
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'sendGuard'), Establish.guardMs || 2000);
        esl.executeAsyncX('gentones', [Establish.guardTone], this.consumer.uuid);
    },
    sendData: function () {
        if (!this.dataTries)
            return this.enter(null);

        debug(this.consumer.session.sid, 'Establish.sendData:', this.dataTries--, 'send_dtmf', this.dataDtmf);
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'sendData'), Establish.dataMs || 5180);
        this.sent = true;
        esl.executeAsyncX('send_dtmf', [this.dataDtmf], this.consumer.uuid);
    },
    DTMF: function (evt, first) {
        var durationMs = evt.headers['DTMF-Duration'] / 8, dtmf;
        if (ConsumerBs8521Pnc.testing && evt.headers['DTMF-Digit'] === '#')
            evt.headers['DTMF-Digit'] = durationMs > 500 ? 'b' : 'B';

        debug(this.consumer.session.sid, 'Establish.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs);
        if (evt.headers['DTMF-Digit'] === 'b') // DataRequest
            return this.signal('sendData') || this;
        else if (!this.sent || evt.headers['DTMF-Digit'] !== 'B') // not sent AND not Acknowledged
            return this;

        this.acknowledged = true;
        return this.enter(null) || this;
    },
});

//==================================================
require('util').inherits(Commands, StateMachine);
function Commands(consumer, next) {
    if (this instanceof Commands === false)
        throw new Error('Constructor', 'ConsumerBs8521Pnc:Commands requires \'new\'');

    Commands.super_.call(this, Commands, { // instance setup
        consumer: consumer,         // reference to parent state-machine
        dtmfs: Object.assign([], { _: '' }), // chronology of dtmf phrases (attr:_ is current dtmf phrase)
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        next: next,                 // callback to signal State complete
        queue: [],                  // queue of Ablah# messages to trot out on each successive ACK (attrib selected records unit selected)
        success: false,             // flag indicating the alarm-call concluded successfully
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Commands, { // class setup
    ackDtmf: 'b@80',
    ackCtrl: 'ATTNN#@80',
    ackParm: 'ATT000#@80',
    ackProg: 'A0000#@80',

    enter: function (cb) {
        debug(this.consumer.session.sid, 'Commands.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), ConsumerBs8521Pnc.nullMs || 130000);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.consumer.session.sid, 'Commands.leave:', this.consumer.substates._ === this ? 'active' : 'inactive');
        this.timeout = worker.resetTimeout(this.timeout);
        if (this.consumer.substates._ === this) // confirm we are the active substate
            this.next && this.next(this.success); // typically delivered to ConsumerBs8521Pnc.cleanup
    },
    DTMF: function (evt, first) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (ConsumerBs8521Pnc.testing && durationMs > 237)
            evt.headers['DTMF-Digit'] = ConsumerBs8521Pnc.testing[evt.headers['DTMF-Digit']] || evt.headers['DTMF-Digit'];

        this.dtmfs._ += evt.headers['DTMF-Digit'];
        debug(this.consumer.session.sid, 'Commands.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.dtmfs._);
        var match;
        for (var cmd in Commands) {
            if (cmd[0] !== '/') // regex indicator
                continue;
            if (!Commands[cmd].re)
                Commands[cmd].re = new RegExp(cmd.slice(1));
            if (!(match = this.dtmfs._.match(Commands[cmd].re)))
                continue;
            this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), ConsumerBs8521Pnc.nullMs || 130000);
            this.dtmfs.push(this.dtmfs._) && (this.dtmfs._ = '');
            this.signal(cmd, match);
            break;
        }
        return this;
    },
    '/A0(\\d{4})#$': function (match) {
        var ackSelect = 'A' + match[1] + '00000000#@80';
        if (!this.queue.selected)
            ackSelect = 'A' + this.consumer.bs8521.raw.slice(12, -2) + '#@80';
        debug.enabled && debug(this.consumer.session.sid, 'Commands.select:', JSON.stringify(match), 'send_dtmf', ackSelect);
        this.queue.selected = true;
        esl.executeAsyncX('send_dtmf', [ackSelect], this.consumer.uuid);
    },
    '/A1(\\d{4})#$': function (match) {
        if (!this.queue.selected)
            this.queue.push('A' + this.consumer.bs8521.raw.slice(12, -2) + '#@80');
        this.queue.push('A000000000000#@80');
        var ackNext = this.queue.shift();
        debug.enabled && debug(this.consumer.session.sid, 'Commands.pendings:', JSON.stringify(match), 'send_dtmf', ackNext);
        esl.executeAsyncX('send_dtmf', [ackNext], this.consumer.uuid);
    },
    '/A2(\\d{2})(\\d{2})#$': function (match) { // equipment control (testing: [2]21234#)
        var txt = 'unsupported', ackCtrl = Commands.ackCtrl.replace('TT', match[1]); // A2TTNN#@80
        if (match[1] !== '00') { // TT
            null;
        } else switch (match[2]) { // NN
            case '01':// Activate door release 1
                txt = 'Activate door release 1';
                if (this.consumer.session.communicator.signal('controlRelease1'))
                    ackCtrl = ackCtrl.replace('NN', match[2]);
                break;
            case '02':// Activate door release 1
                txt = 'Activate door release 2';
                if (this.consumer.session.communicator.signal('controlRelease2'))
                    ackCtrl = ackCtrl.replace('NN', match[2]);
                break;
            case '03':// Activate key safe lock release
                txt = 'Activate door release 1';
                if (this.consumer.session.communicator.signal('atmCommandControlReleaseKeysafe'))
                    ackCtrl = ackCtrl.replace('NN', match[2]);
                break;
            case '04':// Unlock all (fire/evacuation state)
                txt = 'Unlock all (fire/evacuation state)';
                if (this.consumer.session.communicator.signal('atmCommandControlReleaseAll'))
                    ackCtrl = ackCtrl.replace('NN', match[2]);
                break;
        }
        ackCtrl = ackCtrl.replace('NN', '00'); // catch-all NAK incase we match/replace NN above
        debug.enabled && debug(this.consumer.session.sid, 'Commands.control:', JSON.stringify(match), 'send_dtmf', ackCtrl, txt);
        esl.executeAsyncX('send_dtmf', [ackCtrl], this.consumer.uuid);
    },
    '/A3(\\d)#$': function (match) { // default  (testing: [2]3n#)
        var speech = 'default,quiet,normal,loud,up,down,speaker1,speaker2,duplex,simplex'.split(',');
        debug.enabled && debug(this.consumer.session.sid, 'Commands.'+ speech[match[1]] + ':', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf);
        esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.consumer.uuid);
    },
    '/A4(\\d{2})(\\d{3})(\\d{20})#$': function (match) { // parameter define  (testing: [2]41234501234568901234567890#)
        var ackParm = Commands.ackParm.replace('TT', match[1]);
        debug.enabled && debug(this.consumer.session.sid, 'Commands.define:', JSON.stringify(match), 'send_dtmf', ackParm);
        esl.executeAsyncX('send_dtmf', [ackParm], this.consumer.uuid);
    },
    '/A5(\\d{2})(\\d{3})#$': function (match) { // parameter enquiry (testing: [2]512345#)
        var ackParm = Commands.ackParm.replace('TT', match[1]);
        debug.enabled && debug(this.consumer.session.sid, 'Commands.enquiry:', JSON.stringify(match), 'send_dtmf', ackParm);
        esl.executeAsyncX('send_dtmf', [ackParm], this.consumer.uuid);
    },
    '/AC(\\d{4})#$': function (match) { // programming mode (testing: [28]1234#)
        debug.enabled && debug(this.consumer.session.sid, 'Commands.program:', JSON.stringify(match), 'send_dtmf', Commands.ackProg);
        esl.executeAsyncX('send_dtmf', [Commands.ackProg], this.consumer.uuid);
    },
    '/B$': function (match) { // ack (testing: [5]#)
        var ackNext = this.queue.shift();
        debug.enabled && debug(this.consumer.session.sid, 'Commands.ack:', JSON.stringify(match), ackNext || '-');
        if (!ackNext)
            return;

        esl.executeAsyncX('send_dtmf', [Commands.ackNext], this.consumer.uuid);
    },
    '/a7$': function (match) { // speak (testing: [*]7)
        debug.enabled && debug(this.consumer.session.sid, 'Commands.speak:', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf);
        esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.consumer.uuid);
    },
    '/a8$': function (match) { // listen (testing: [*]8)
        debug.enabled && debug(this.consumer.session.sid, 'Commands.listen:', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf);
        esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.consumer.uuid);
    },
    '/a9$': function (match) { // clear (testing: [*]9)
        var ackClear = 'A000000#@80';
        debug.enabled && debug(this.consumer.session.sid, 'Commands.clear:', JSON.stringify(match), 'send_dtmf', ackClear);
        esl.executeAsyncX('send_dtmf', [ackClear], this.consumer.uuid);
        //this.success = true;
        //this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), ConsumerBs8521Pnc.closeMs);
    },
    '/aD$': function (match) { // close (testing: [*0])
        debug.enabled && debug(this.consumer.session.sid, 'Commands.close:', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf);
        esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.consumer.uuid);
        this.success = true;
        this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), ConsumerBs8521Pnc.closeMs);
    },
    '/a#$': function (match) { // null (testing: [*]#)
        debug.enabled && debug(this.consumer.session.sid, 'Commands.null:', JSON.stringify(match));
        esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.consumer.uuid);
    },
});
