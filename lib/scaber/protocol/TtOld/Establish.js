var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:TtOld:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        attempts: isNaN(leg.session.context.ttold) ? 2 : leg.session.context.ttold, // number of ENQ attempts
        conclude: conclude,         // callback to signal State complete
        data: [''],                 // accumulator for received data - predict the 'D' in-case we miss it
        dsp: undefined,             // spandsp detection mode
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    ackMs: 500,             // delay after sending the burst message ACK tone
    ackTones: '%(500,0,1400);', // tones to acknowledge the burst message
    actionMs: 500,          // wait after receiving a junk-tone - sect4.1 para5
    enqMs: 5000,            // repeat enquire delay (+duration of enqTones)
    enqTones: '%(2000,0,1400);',    // DTMF to provoke the DataMessage - sect4.3.1.1 para3
    junkMs: 3700,           // wait for junk-tone - sect4.1 para4
    silenceMs: 1000,        // end of data delay - sect3.2.5 para1

    enter: function () {
        debug(this.leg.session.sid, 'enter:', this.attempts ? 'spandsp_start_tone_detect telecare-junk' : 'SKIP');
        if (!this.attempts) // possibly disabled by configuration 
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.junkMs);
        esl.executeAsyncX('spandsp_start_tone_detect', [this.dsp = 'telecare-junk'], this.leg.uuid);
    },
    leave: function (conclusion) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.leg.session.sid, 'leave:');
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, exports.name + '.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            debug(sm.leg.session.sid, 'leave.1:', 'spandsp_stop_tone_detect', new Date);
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.leg.uuid, this);

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.leg.session.sid, 'leave.2:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.leg.uuid, this);

        });
    },
    action: function () {
        debug(this.leg.session.sid, 'action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        var enqMs = esl.tgmlMs(exports.enqTones) + exports.enqMs;
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), enqMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(exports.name + '.action:', err);

        }, function () {
            if (sm.dsp === 'telecare-burst')
                return this();

            debug(sm.leg.session.sid, 'action.1:', 'spandsp_stop_tone_detect', new Date);
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.leg.uuid, this);

        }, function () {
            if (sm.dsp === 'telecare-burst')
                return this();

            debug(sm.leg.session.sid, 'action.2:', 'spandsp_start_tone_detect telecare-burst', new Date);
            esl.executeAsyncX('spandsp_start_tone_detect', [sm.dsp = 'telecare-burst'], sm.leg.uuid, this);

        }, function () {
            debug(sm.leg.session.sid, 'action.3:', 'gentones', 'ENQ', exports.enqTones, enqMs + 'ms', new Date);
            esl.executeAsyncX('gentones', [exports.enqTones], sm.leg.uuid, this);

        });
    },
    release: function () {
        debug(this.leg.session.sid, 'release:');
        this.enter(null, 'release');
    },
    DETECTED_TONE: function (evt) {
        if (evt.headers['Detected-Tone'].startsWith('telecare-junk')) {
            debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone'], exports.actionMs + 'ms', new Date);
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.actionMs);
        }

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.silenceMs);
        this.data[0] += evt.headers['Detected-Tone']['telecare-burst:'.length];
        debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone'], this.data, exports.silenceMs, new Date);
        return this;
    },
    timeout: function () {
        if (this.data[0] !== this.data[1]) {
            debug.enabled && debug(this.leg.session.sid, 'timeout:', JSON.stringify({ data: this.data }));
            return this.data.unshift('');
        }

        var tt = {
            callcode: this.data[0].slice(-1),
            generic: '2',
            grouped: this.data[0].slice(-1) === '1',
            hvs: true,
            identity: this.data[0].slice(0, -1),
            type: '2',
            verified: this.verified = true,
        };
        debug.enabled && debug(this.leg.session.sid, 'timeout:', JSON.stringify({ data: this.data, tt: tt }));

        if (tt.grouped && 'ttoldGrp' in this.leg.session.context) // redirect dial-string for any TTOld Grouped Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.ttoldGrp, _ttoldGrp: data });

        if (!tt.hvs && 'ttoldTvs' in this.leg.session.context) // non-HVS Leg and have non-HVS redirect dial-string
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.ttoldTvs, _ttoldTvs: data });

        if ('ttoldAny' in this.leg.session.context) // redirect dial-string for any TTOld Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.ttoldAny, _ttoldAny: data });

        var ackMs = exports.ackMs + esl.tgmlMs(exports.ackTones);
        Object.assign(this.leg.session.payload, {
            protocol: 'TT Old',
            tt: tt,
            scheme: undefined, // populated by Select for Grouped legs
            unit: undefined, // populated by Select for Grouped legs
            originUser: tt.identity.replace(/^0+/, '') || '0', // updated by Select for Grouped legs
            event: tt.callcode,
            grouped: tt.grouped,
            location: '',
        });
        Object.assign(this.leg, { grouped: tt.grouped ? new module.parent.exports.Grouped : undefined, hvs: tt.hvs });
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), ackMs);
        debug(this.leg.session.sid, 'timeout.1:', 'gentones', 'ACK', exports.ackTones, ackMs + 'ms', new Date);
        esl.executeAsyncX('gentones', [exports.ackTones], this.leg.uuid);
    },
});
