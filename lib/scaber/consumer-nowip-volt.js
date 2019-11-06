#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('consumer:nowip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = ConsumerNowipVolt;

require('util').inherits(ConsumerNowipVolt, require('../state-machine'));
function ConsumerNowipVolt(session, uris) {
    if (this instanceof ConsumerNowipVolt === false)
        throw new Error('Constructor ConsumerNowipVolt requires \'new\'');
    ConsumerNowipVolt.super_.call(this, consumerState, {
        sent: false,
        session: session,
        success: false,
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: new Set,
    });
}

var consumerState = { // _this_ of all methods is the StateMachine instance
    enter: function onConsumerNowipVoltEnter() {
        console.log('onConsumerNowipVoltEnter:');
        return this;
    },
    leave: function onConsumerNowipVoltLeave() {
        console.log('onConsumerNowipVoltLeave:');
    },
    cleanup: function onConsumerNowipVoltCleanup(err, evt) { // recursive on successive uuid_kill callbacks
        if (!this.uuids.size)
            return this.success ? this.session.enter(null) : this.session.signal('consume'); // all-done OR try next consumer;
        var uuid = this.uuids.values().next().value;
        this.uuids.delete(uuid);
        esl.bgapiX('uuid_kill', [uuid], this.signal.bind(this, 'cleanup'));
    },
    activate: function onConsumerNowipVoltActivate() { // multiple activations by session each time round the list of consumers
        this.success = false; // the starting-point
        if (Array.isArray(this.uris)) { // convert array of {scheme,user,password,host,port,params,headers} to dialstring
            if (this.constructor.name in main.state)
                this.uris.push.apply(this.uris, this.uris.splice(0, ++main.state[this.constructor.name] % this.uris.length));
            else
                main.state[this.constructor.name] = 0;
            this.uris = esl.dialstring(this.uris);
        }
        console.log('onConsumerNowipVoltActivate:', this.uris);
        if (!this.uris)
            return;

        esl.bgapiX('originate', [esl.nvp({
            //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
            appello_consumer: !undefined, // true as this is a consumer leg
            appello_unique: this.session.locals.unique,
            originate_continue_on_timeout: true,
            originate_timeout: 15,
            origination_caller_id_name: this.session.locals.alegEvt.headers['Caller-Caller-ID-Name'] || '_undef_',
            origination_caller_id_number: this.session.locals.origin,
        }, '{}' + this.uris), '&park'], this.signal.bind(this, 'parked'));

        return this;
    },
    parked: function onConsumerNowipVoltParked(err, evt) { // originate has completed
        console.log('onConsumerNowipVoltParked:', evt.body.replace(/\s+$/, ''));
        var match = evt.body.match(/^\+OK\s+([-\w]+)/);
        if (!match) // ultimately unsuccessful
            return this.signal('cleanup');
        this.uuids.add(match[1]);
        esl.bgapiX('uuid_bridge', [match[1], this.session.locals.alegEvt.headers['Unique-ID']], this.signal.bind(this, 'bridged'));
    },
    bridged: function onConsumerNowipVoltBridged(err, evt) { // bridge has completed
        console.log('onConsumerNowipVoltBridged:', evt.body.replace(/\s+$/, ''));
        if (!evt.body.startsWith('+OK')) // ulitimately unsuccessful
            return this.signal('cleanup');
        this.success = true;
    },
    CHANNEL_: function onConsumerNowipVoltChannel(evt, aleg) { // miscellaneous CHANNEL_*** events
        console.log('onConsumerNowipVoltChannel:', evt.headers['Unique-ID'], evt.type);
        var nowip = this.session.locals.nowipMesg;
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.locals.communicator.signal('answer');
        if (!nowip || this.sent || !['CHANNEL_PROGRESS', 'CHANNEL_PROGRESS_MEDIA', 'CHANNEL_ANSWER'].includes(evt.type))
            return this;
        this.sent = true;
        esl.atm(evt, { type: 1, data: nowip.ATM.data[0], wgs: (nowip.ATM.wgs || [])[0], blocking: true });
        return this;
    },
    CHANNEL_DESTROY: function onConsumerNowipVoltChannelDestroy(evt, aleg) { // b-leg has ended
        console.log('onConsumerNowipVoltChannelDestroy:', evt.headers['Unique-ID']);
        this.uuids.delete(evt.headers['Unique-ID']);
        if (+evt.headers['variable_bridge_uepoch']) // bridged & released
            return this.signal('cleanup') || this;
        return this;
    },
    MESSAGE: function onConsumerNowipVoltMessage(evt, aleg) { // received NOWIP ack
        var sm = this;
        this.ackd || chain(function cleanup(err, js) {
            console.log('onConsumerNowipVoltMessage:', evt.headers['Unique-ID'], err ? err : JSON.stringify(js));
            if (!js)
                return;
            sm.ackd = (js.ATM.type[0] === 'A');

        }, function () {
            xml2js.parseString(evt.body, this);

        }, function (js) {
            if (!js.ATM)
                return this(Object.assign(new Error('invalid NOWIP message'), { xml: evt.body }));
            var mandatory = new Set(['version', 'type', 'data', 'time', 'mac']);
            mandatory.forEach(function (key, idx, arr) { key in this && arr.delete(key) }, js.ATM);
            if (mandatory.size)
                return this(Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
            this(null, js); // { ATM: { version, type, data, time, mac } }

        });
        return this;
    },
};
