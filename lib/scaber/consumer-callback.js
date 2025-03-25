#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    debug = require('debug')('consumer:callback'),
    esl = require('../esl'),
    jwt = require('jsonwebtoken'),
    main = require.main.exports,
    mysql = require('../mysql'),
    os = require('os'),
    StateMachine = require('../state-machine'),
    worker = require('./worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags };

require('util').inherits(module.exports = exports = ConsumerCallback, StateMachine);
function ConsumerCallback(session) {
    if (this instanceof ConsumerCallback === false)
        throw new Error('Constructor ConsumerCallback requires \'new\'');

    ConsumerCallback.super_.call(this, ConsumerCallback, {
        //answered: undefined,        // consumer answered state
        callback: undefined,        // { to_number, to_unit }
        d2: undefined,              // reference to Detect2 engine
        data: '',                   // tone/dtmf accumulator
        //direction: undefined,       // tristate to track prevailing state (undefined, 'speak', 'listen')
        grouped: undefined,         // placeholder for grouped/dispersed object - set/updated by sub-protocol-establish
        hvs: undefined,             // handsfree-voice-switched - set by sub-protocol-establish
        //interval: undefined,        // interval handle
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        protocol: undefined,        // protocol Constructor
        released: undefined,        // consumer released timestamp
        selected: null,             // track which unit is selected - updated by sub-protocol-action
        session: session,           // a reference to the owning session
        //speech: undefined,          // tristate to track prevailing state (undefined, 'simplex', 'duplex')
        spandsp: false,             // keep track whether spandsp is running
        stabilised: false,          // flag to prevent transaction until stabilised
        stmf: false,                // whether we're using STMF - updated & used by sub-protocols
        substates: Object.assign([], { _: undefined }), // chronology of past substates (attr:_ is current substate)
        timeout: undefined,         // timeout handle
        uuid: undefined,
        uuids: {},                  // { uuid: boolean } collection of active outbound channel-ids
    }); // this, ?initial, ?assign, ?enterArgs...
    Object.defineProperties(this, {
        d2: { value: new main.modules.detect2(this), writable: false },
        session: { writable: false, enumerable: false },
        substates: { writable: false },
    });
}

Object.assign(ConsumerCallback, { // _this_ of all methods is the StateMachine instance
    advisee: 1,     // luc
    protocolMs: 5000, // assume dispersed if a grouped-call doesn't begin protocol within ms after answer 
    dtmfMs: 230,    // dtmf silence timeout
    protocolMs: 5000, // assume dispersed if a grouped-call doesn't begin protocol within ms after answer
    rtpMs: 20,
    portTransports: { // map of user-registration profile to remote-host target port/transport
        ext4tcp: ':5060;transport=tcp',
        ext4tls: ':5061;transport=tls',
        ext4udp: ':5060;transport=udp',
        ext6tcp: ':5060;transport=tcp',
        ext6tls: ':5061;transport=tls',
        ext6udp: ':5060;transport=udp',
        int4tcp: ':5060;transport=tcp',
        int4tls: ':5061;transport=tls',
        int4udp: ':5060;transport=udp',
        int6tcp: ':5060;transport=tcp',
        int6tls: ':5061;transport=tls',
        int6udp: ':5060;transport=udp',
    },
    toneMs: 2500,   // tone silence timeout

    enter: function onConsumerCallbackEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerCallbackLeave() {
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        if (this.substates._) // active substate need archiving
            this.substates.push(this.substates._) && (this.substates._ = null);
        for (var i = 0; i < this.substates.length; i++) // ensure all substates are exited
            this.substates[i].enter(null, true);
        if (this.uuid && !this.released) {
            debug(this.session.sid, 'leave:', 'hangup', this.uuid);
            esl.executeAsyncX('hangup', [], this.uuid);
            this.uuids[this.uuid] = false;
        }
        for (var uuid in this.uuids) {
            if (!this.uuids[uuid])
                continue;
            debug(this.session.sid, 'leave:', 'hangup', uuid);
            esl.executeAsyncX('hangup', [], uuid);
        }
        this.d2.cleanup();
    },
    activate: function onConsumerCallbackActivate(callback) { // { to_number, to_unit }
        debug.enabled && debug(this.session.sid, 'activate:', UTIL.stringify(callback), callsites()[2].toString());
        this.callback = callback;

        var sm = this;
        chain(function (err) {
            err && console.log(sm.session.sid, 'onConsumerCallbackActivate:', err);

        }, function () {
            this.index = sm.session.sid;
            if (!callback.to_number.startsWith('+0')) // regular e164 - just move along
                return this();

            if (main.modules.aws.getIsAwsEnvironment() && callback.to_number.startsWith('+0'))  // ATA but in AWS - send std outbound call
            return this();

            mysql('select * from sipUsers where name="registration" and user=? order by length(user) desc', [callback.to_number], this);

        }, function (sipUsers, meta) {
            debug.enabled && debug(sm.session.sid, 'activate:', 'lookup', UTIL.stringify(sipUsers));
            if (!sipUsers) { // skipped the MYSQL lookup - so traditional originate to PSTN
                null;
            } else if (!sipUsers.length) { // empty MYSQL result-set - abort
                console.log(sm.session.sid, 'onConsumerCallbackActivate: unknown ATA');
                return sm.session.signal('consume', true);
            } else try { // non-empty MYSQL result-set - so ATA originate
                this.sipUser = JSON.parse(sipUsers[0].value);
                if (this.sipUser.expires * 1000 < Date.now())
                    return sm.session.signal('consume', true);
            } catch (ex) {
                console.log(sm.session.sid, 'onConsumerCallbackActivate:', ex.message, sipUsers[0].value);
                return sm.session.signal('consume', true);
            }

            sm.session.payload.paid = sm.session.context.paid && ('sip:' + sm.session.context.paid + '@' + os.hostname());
            if (!sipUsers) { // traditional PSTN originate
                debug(sm.session.sid, 'activate:', 'bridge', callback, new Date);
                this.originate = esl.nvp({
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.sid,
                    //drop_dtmf: true,
                    origination_caller_id_name: sm.session.firstEvt.headers['Caller-Caller-ID-Name'],
                    origination_caller_id_number: sm.session.firstEvt.headers['Caller-Caller-ID-Number'],
                    originate_timeout: 15,
                    park_after_bridge: true,
                    rtp_digit_delay: ConsumerCallback.rtpMs || 20,
                    sip_cid_type: 'rpid',
                    'sip_h_P-Asserted-Identity': sm.session.payload.paid,
                }, '{}' + 'sofia/gateway/magrathea/' + callback.to_number);
            } else if (this.sipUser.hostname !== os.hostname()) // need to expedite to ATA via another host
                this.originate = esl.nvp({
                    absolute_codec_string: undefined,
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.sid,
                    origination_caller_id_name: sm.session.firstEvt.headers['Caller-Caller-ID-Name'],
                    origination_caller_id_number: sm.session.firstEvt.headers['Caller-Caller-ID-Number'],
                    origination_privacy: undefined,
                    originate_timeout: 15,
                    park_after_bridge: true,
                    rtp_digit_delay: ConsumerCallback.rtpMs || 20,
                    rtp_secure_media: this.sipUser.profile.endsWith('tls'),
                    sip_cid_type: 'rpid',
                    'sip_h_P-Asserted-Identity': sm.session.payload.paid,
                    'sip_h_X-AppelloExpedite': jwt.sign({
                        byps: true, // bypass_media - can do something clever with this to improve the media path
                        dest: this.sipUser.reg_user,
                        name: sm.session.firstEvt.headers['Caller-Caller-ID-Name'],
                        numb: sm.session.firstEvt.headers['Caller-Caller-ID-Number'],
                        priv: undefined,
                        prfx: this.sipUser.reg_user,
                    }, main.cache.tls.key, { algorithm: 'HS256' }), // symetric signing using key gives a shorted JWT
                }, `{}sofia/${this.sipUser.profile}/${this.sipUser.reg_user}@${this.sipUser.hostname}${exports.portTransports[this.sipUser.profile]}`);
            else // originate to local-ATA
                this.originate = esl.nvp({
                    absolute_codec_string: undefined,
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.sid,
                    origination_caller_id_name: sm.session.firstEvt.headers['Caller-Caller-ID-Name'],
                    origination_caller_id_number: sm.session.firstEvt.headers['Caller-Caller-ID-Number'],
                    origination_privacy: undefined,
                    originate_timeout: 15,
                    park_after_bridge: true,
                    rtp_digit_delay: ConsumerCallback.rtpMs || 20,
                    rtp_secure_media: this.sipUser.profile.endsWith('tls'),
                    sip_cid_type: 'rpid',
                    'sip_h_P-Asserted-Identity': sm.session.payload.paid,
                }, `{}sofia/${this.sipUser.url.replace('sip:', this.sipUser.profile + '/')}`);

            debug(sm.session.sid, 'activate:', 'originate', this.originate);
            // must use originate+uuid_bridge as dptool-bridge leads to temperamental behaviour
            esl.executeAsyncX('eval', ['${originate ' + this.originate + ' &park()}'], sm.session.communicator.uuid, this);
        });

        return this;
    },
    stabilised: function onConsumerCallbackStabilised() {
        var unit = +this.callback.to_unit;
        this.stabilised = true;
        debug.enabled && debug(this.session.sid, 'stabilised: unit', unit, callsites()[2].toString());
        var args = Object.assign(args = ['select', [, unit.toString()], unit, Object], { Transaction: this.protocol.transaction.apply(this, args), signal: 'selected' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    selected: function onCommunicatorDetectSelected() { // from established/catalogued
        debug(this.session.sid, 'selected:', this.grouped.unit);
    },
    substate: function onConsumerCallbackSubstate(Substate, signal, arg) { // helper to activate a new Substate
        var sm = Substate && Substate.super_;
        if (Substate) { // ensure Substate is derived from StateMachine
            while (sm && sm != StateMachine)
                sm = sm.super_;
            if (!sm) // does not inherit from StateMachine
                throw new Error('Substate must be an instance of StateMachine');
        }

        debug(this.session.sid, 'substate:', Substate && Substate.name, new Date);
        if (sm = this.substates._) // existing substate assignment test
            this.substates.push(this.substates._) && sm.enter(this.substates._ = null, true); // push first to filter the callback
        this.substates._ = new Substate(this, signal && function conclude(index) {
            if (index === this.substates.length) // is still the active substate
                this.signal.apply(this, [signal].concat(Array.from(arguments).slice(1)));
        }.bind(this, this.substates.length), arg); // index is a snapshot the current substate index for callback filtering
        return this;
    },
    orphaned: function onConsumerCallbackOrphaned() { // communicator has detached
        var orphaned = { selected: this.selected || '-', protocol: this.session.payload.protocol || '-', leg: this.uuid || '-' };
        debug(this.session.sid, 'orphaned:');
        //return this.enter(null); // returns undefined unless consumer should be retained
        if (!this.uuid)
            return undefined; // permit session cleanup

        this.signal(this.selected ? 'clear' : this.protocol ? 'close' : 'release');
        return this.uuid; // continue session as we have a consumer-leg to cleanup
    },
    clear: function onConsumerCallbackClear() {
        debug(this.session.sid, 'clear:');
        var args = this.protocol.transaction && Object.assign(args = ['quick', {}, 'clear', Object], { Transaction: this.protocol.transaction.apply(this, args), signal: 'close' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    close: function onConsumerCallbackClose() {
        debug(this.session.sid, 'close:');
        var args = this.protocol.transaction && Object.assign(args = ['quick', {}, 'close', Object], { Transaction: this.protocol.transaction.apply(this, args), signal: 'release' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    release: function onConsumerCallbackRelease() {
        debug(this.session.sid, 'release:');
        esl.executeAsyncX('hangup', [], this.uuid);
    },
    CHANNEL_CREATE: function onConsumerCallbackChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[this.uuid = evt.headers['Unique-ID']] = true;
        if (this.d2.digit('')) // offer to Detect2
            return this;

        return this;
    },
    CHANNEL_: function onConsumerCallbackChannel(evt, first) { // miscellaneous CHANNEL_*** events
        switch (evt.type) {
            case 'CHANNEL_PROGRESS_MEDIA':
                debug(this.session.sid, evt.type + ':', 'spandsp_start_tone_detect:grouped', new Date);
                this.spandsp = esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-grouped'], this.uuid) || true;
                break;

            case 'CHANNEL_ANSWER':
                debug(this.session.sid, evt.type + ':');
                this.session.advisees[exports.advisee] = this;
                this.session.signal('answer');
                this.session.keepalived = new Date; // enables keepalives to commence from the first sent DTMF
                this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ConsumerCallback.protocolMs);
                var sm = this;
                chain(null, function () {
                    if (sm.spandsp)
                        return this();

                    debug(sm.session.sid, evt.type + ':', 'spandsp_start_tone_detect:grouped', new Date);
                    sm.spandsp = esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-grouped'], sm.uuid, this) || true;

                }, function () {
                    debug(sm.session.sid, evt.type + ': uuid_bridge', sm.session.communicator.uuid, sm.uuid, new Date);
                    esl.executeAsyncX('eval', ['${uuid_bridge ' + sm.session.communicator.uuid + ' ${uuid}}'], sm.uuid, this);

                })
                break;

            case 'CHANNEL_BRIDGE':
                debug(this.session.sid, evt.type + ':');
                this.bridged = true;
                //esl.executeAsyncX('set', ['park_after_bridge=true'], this.uuid);
                break;

            default:
                debug(this.session.sid, evt.type + ':');
                break;
        }
        return this;
    },
    CHANNEL_DESTROY: function onConsumerCallbackChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'bridged =', this.bridged);
        this.session.advisees[exports.advisee] = undefined;
        this.released = new Date;
        this.uuid = (this.uuids[evt.headers['Unique-ID']] = false) || undefined;
        this.session.signal('consume', true);
        return this;
    },
    CUSTOM: function onConsumerCallbackCustom(evt, first) {
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onConsumerCallbackTone(evt, first) {
        var signal = this.d2.digit(evt.headers['Detected-Tone']); // offer to Detect2
        if (this.substates._ && this.substates._.signal(signal || evt.type, evt, first))
            return this;

        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone'] + (this.protocol ? ' ignored' : ''), ConsumerCallback.toneMs + 'ms');
        if (this.protocol)
            return this;

        if (!evt.headers['Detected-Tone'].startsWith('telecare-grouped:'))
            return this;

        this.data += 'T' + evt.headers['Detected-Tone'].slice('telecare-grouped:'.length);
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ConsumerCallback.toneMs);
        return this;
    },
    DTMF: function onConsumerCallbackDtmf(evt, first) {
        if (this.spandsp) {
            debug(this.session.sid, 'DTMF:', 'spandsp_stop_tone_detect', new Date);
            this.spandsp = esl.executeAsyncX('spandsp_stop_tone_detect', [], this.uuid) && false;
        }

        var signal = this.d2.digit(evt.headers['DTMF-Digit']); // offer to Detect2
        if (this.substates._ && this.substates._.signal(signal || evt.type, evt, first))
            return this;

        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8) + (this.protocol ? ' ignored' : ''), ConsumerCallback.dtmfMs + 'ms');
        if (this.protocol)
            return this;

        this.data += evt.headers['DTMF-Duration'] < 4000 ? evt.headers['DTMF-Digit'] : evt.headers['DTMF-Digit'].toLowerCase();
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ConsumerCallback.dtmfMs);
        return this;
    },
    timeout: function onConsumerCallbackTimeout() {
        var match = this.data.match(/(b|\d#|DB|T1850|T1850T1400|.)$/); // returns null on failed match
        switch (match && match[1]) {
            case 'b': // Bs8521
                this.protocol = require('./protocol/Bs8521');
                break;

            //case null: // 5.2.1.3.4	Switch to TT92 protocol states dispersed callbacks are assumed to be TtNew
            case '0#': // Tt92
                this.protocol = require('./protocol/Tt92');
                break;

            case null: // no-protocol assume dispersed speaking TtNew
            case 'DB': // TtNew
                this.protocol = require('./protocol/TtNew');
                break;

            case 'T1850': // TtOld
            case 'T1850T1400':
                this.protocol = require('./protocol/TtOld');
                break;
        }
        debug(this.session.sid, 'timeout:', this.data || '<silence>', this.protocol && this.protocol.constructor.name);
        if (!this.protocol)
            null;
        else if (match) // grouped
            this.protocol.Stabilise && this.signal('substate', this.protocol.Stabilise, 'stabilised', undefined);
        else // dispersed
            this.stabilised = true;
        return this;
    },
    transaction: function onConsumerCallbackTransaction(type, match, /* ..., cb */) { // communicator-to-consumer transaction
        if (type === 'acknowledge' && this.substates._ && this.substates._.signal.apply(this.substates._, arguments))
            return this;

        var transaction = (this.protocol || {}).transaction, // does the Protocol implement transactions
            Transaction = transaction && transaction.apply(this, arguments); // (type, match, ..., cb)
        debug.enabled && debug(this.session.sid, 'transaction:', UTIL.stringify(argsMap(arguments)), !transaction ? 'UNSUPPORTED by protocol' : !Transaction ? 'UNIMPLEMENTED for protocol' : Transaction.name);
        var cb = arguments[arguments.length - 1];
        if (!this.stabilised)
            return (Array.isArray(match) ? cb(null, '') : cb(null, '-NOTREADY')) || this; // match being Object indicates outcome-keyword is expected

        if (!transaction) // protocol does not support transactions
            return (Array.isArray(match) ? cb(null, '') : cb(null, '-UNSUPPORTED')) || this; // match being Object indicates outcome-keyword is expected

        if (!Transaction) // no Transaction StateMachine available
            return (Array.isArray(match) ? cb(null, '') : cb(null, '-UNIMPLEMENTED')) || this; // match being Object indicates outcome-keyword is expected

        return this.signal('substate', Transaction, undefined, Array.from(arguments)); // [type, match, ..., cb]
    },
});
