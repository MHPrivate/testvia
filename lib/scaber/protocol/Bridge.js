#! /usr/bin/env node-strict
module.exports = exports = new (function Bridge() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Protocol:' + module.exports.constructor.name,
    chain = require('scope-chain'),
    debug = require('debug')(Variant.toLowerCase()),
    esl = require('../../esl'),
    main = require.main.exports,
    rpscb = require('../../rpscb'),
    worker = require('../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(leg, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor ' + Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    random: [], // refillable collection of 100 random numbers
    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.leg.session.sid, 'leave:', UTIL.stringify({ conclusion: conclusion }));
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        this.conclude && this.conclude(conclusion); // Establish
    },
    action: function () {
        if (!Establish.random.length)
            while (Establish.random.length < 100)
                Establish.random.push(Math.random());
        var random = Establish.random.pop(), bridgeRatio = (+this.leg.session.context.bridgePct || 100) / 100;
        debug(this.leg.session.sid, 'action:', `random ${random} >= ${bridgeRatio} is ${random >= bridgeRatio}`);
        if (random >= bridgeRatio) {
            delete this.leg.session.context.bridge;
            delete this.leg.session.context.noCdr;
        }

        if ('bridge' in (this.leg.session.context || {}))
            return this.signal('conclude', this.leg.session.context.bridge);

        var evt = this.leg.createEvt;
        rpscb.publish('offerCli:' + evt.headers['Caller-Caller-ID-Number'], function (err, outs, res) {
            err && console.log(sm.leg.session.sid, Variant + ':action', outs, err);
            if (!evt) // prevent repeated conclusions
                return;
            if (err && outs) // ignore error where there are further responses to be had
                return;

            if (!res)
                null;
            else if (res.host)
                evt = this.signal('conclude', evt.headers['Caller-Channel-Name'].replace(/@.*/, '@' + res.host)) && udefined;
            else if (res.e164)
                evt = this.signal('conclude', 'gateway/magrathea/' + res.e164) && undefined;

            if (evt)
                evt = this.signal('conclude', undefined) && undefined; // prevent repeated conclusions
        }.bind(this));
    },
    conclude: function (bridge) {
        var conclusion;
        switch (bridge) {
            case undefined: // missing 'bridge' - so refuse (this protocol) - start recording below
                conclusion = 'refused';
                break;

            case '': // empty 'bridge' - so release/deflect (the call) - start recording below
                conclusion = 'release';
                break;

            default: // presumably a useful 'bridge' target' - without recording to allow bypass_media
                conclusion = 'verified';
                break;
        }
        debug.enabled && debug(this.leg.session.sid, 'conclude:', UTIL.stringify({ conclusion: conclusion }), new Date);

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, Variant + ':conclude', err);
            sm.enter(null, conclusion);

        }, function () {
            if (conclusion === 'verified') // forward using bypass_media
                esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} forward'], sm.leg.uuid, this);
            else if (conclusion === 'release') // deflect
                esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} deflect'], sm.leg.uuid, this);
            else if (sm.leg.session.context.record || main.hack.record) // proceed with next protocol
                esl.executeAsyncX('record_session', ['${record_file_path}'], sm.leg.uuid, this);
            else
                this();

        });
        return this;
    },
});
