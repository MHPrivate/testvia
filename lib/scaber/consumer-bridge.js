#! /usr/bin/env node-strict
var callsites = require('callsites');
var chain = require('scope-chain');
var debug = require('debug')('consumer:bridge');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = ConsumerBridge;

require('util').inherits(ConsumerBridge, require('../state-machine'));
function ConsumerBridge(session, uris) {
    if (this instanceof ConsumerBridge === false)
        throw new Error('Constructor ConsumerBridge requires \'new\'');

    ConsumerBridge.super_.call(this, ConsumerBridge, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: {}, // { uuid: boolean } collection of active outbound channel-ids
    });
}

Object.assign(ConsumerBridge, {
// _this_ of all methods is the StateMachine instance
    enter: function onConsumerBridgeEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerBridgeLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        for (var uuid in this.uuids) {
            if (!this.uuids[uuid])
                continue;
            debug(this.session.sid, 'leave:', 'hangup', uuid);
            esl.executeAsyncX('hangup', [], uuid);
        }
    },
    activate: function onConsumerBridgeActivate() { // multiple activations by session each time round the list of consumers
        debug.enabled && debug(this.session.sid, 'activate:', JSON.stringify(this.uris), callsites()[2].toString());
        if (Array.isArray(this.uris)) { // convert array of {scheme,user,password,host,port,params,headers} to dialstring
            if (this.constructor.name in main.state) // rotate the available URIs according to the count of invokations
                this.uris.push.apply(this.uris, this.uris.splice(0, ++main.state[this.constructor.name] % this.uris.length));
            else // initialise the count of invokations
                main.state[this.constructor.name] = 0;
            this.uris = esl.dialstring(this.uris);
        }
        if (!this.uris) // no available destination URIs
            return undefined;

        var sm = this;
        chain(this.signal.bind(this, 'bridged'), function () {
            esl.executeAsyncX('set', ['hangup_after_bridge=true'], sm.session.communicator.uuid, this);

        }, function () {
            debug(sm.session.sid, 'activate:', 'bridge', sm.uris);
            esl.executeAsyncX('bridge', [esl.nvp({
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.unique,
                    originate_timeout: 15,
                    sip_cid_type: 'rpid',
                }, '{}' + sm.uris)], sm.session.communicator.uuid, this);

        });

        return this;
    },
    bridged: function onConsumerBridgeBridged(err, evt) { // bridge has completed
        debug(this.session.sid, 'bridged:', evt.body.replace(/\s+$/, ''));
        if (!evt.body.startsWith('+OK')) // ultimately unsuccessful
            return this.signal('cleanup') || this;
        return this;
    },
    CHANNEL_CREATE: function onConsumerBridgeChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[evt.headers['Unique-ID']] = true;
        return this;
    },
    CHANNEL_: function onConsumerBridgeChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':');
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.signal('answer');
        return this;
    },
    CHANNEL_DESTROY: function onConsumerBridgeChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'bridged =', this.bridged);
        this.uuids[evt.headers['Unique-ID']] = false;
        return this;
    },
    CUSTOM: function onCommunicatorBridgeCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorBridgeTone(evt, first) {
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorBridgeDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorBridgeMessage(evt, first) {
        debug(this.session.sid, 'MESSAGE:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
});
