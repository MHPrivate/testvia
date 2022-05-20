#! /usr/bin/env node-strict
var callsites = require('callsites');
var chain = require('scope-chain');
var debug = require('debug')('consumer:simple');
var esl = require('../esl');
var main = require.main.exports;
var os = require('os');

require('util').inherits(module.exports = exports = ConsumerSimple, require('../state-machine'));
function ConsumerSimple(session, uris) {
    if (this instanceof ConsumerSimple === false)
        throw new Error('Constructor ConsumerSimple requires \'new\'');

    ConsumerSimple.super_.call(this, ConsumerSimple, {
        bridged: false, // used to track whether the caller was bridged to the arc
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: {}, // { uuid: boolean } collection of active outbound channel-ids
    });
}

Object.assign(ConsumerSimple, { // _this_ of all methods is the StateMachine instance
    enter: function onConsumerSimpleEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerSimpleLeave() {
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
    cleanup: function onConsumerSimpleCleanup(err, evt) {
        debug(this.session.sid, 'cleanup:', 'bridged =', this.bridged, callsites()[2].toString());
        var legs = 0;
        for (var uuid in this.uuids)
            if (this.uuids[uuid]) {
                legs++;
                debug(this.session.sid, 'cleanup:', 'hangup', uuid);
                esl.executeAsyncX('hangup', [], uuid);
            }
        if (!legs) // all legs cleaned-up
            this.session.signal('consume', this.bridged); // try next consumer OR task;
        return this;
    },
    activate: function onConsumerSimpleActivate() { // multiple activations by session each time round the list of consumers
        debug.enabled && debug(this.session.sid, 'activate:', JSON.stringify(this.uris), callsites()[2].toString());
        process.emit('writeCallData', this.session);
        this.bridged = !this.session.communicator.uuid; // fake bridged when no Communicator
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
                console.log(this.session.id, 'onConsumerSimpleActivate-Error: target URI(s) required');
            return this.session.signal('consume', false);
        }

        var sm = this;
        chain(function cleanup(err, evt) {
            err && console.log(sm.session.sid, 'onConsumerSimpleActivate:', err);
            sm.signal('parked', evt);

        }, function () {
            var originate = esl.nvp({
                //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
                appello_consumer: !undefined, // true as we are a consumer leg
                appello_unique: sm.session.sid,
                drop_dtmf: true,
                originate_continue_on_timeout: true,
                originate_timeout: 15,
                origination_caller_id_name: '_undef_',
                origination_caller_id_number: sm.session.payload.e164 ? '+' + sm.session.payload.e164 : '+0' + sm.session.payload.originUser,
                sip_invite_call_id: sm.session.evoId,
            }, '{}' + sm.uris);

            debug(sm.session.sid, 'activate.2:', 'originate', originate);
            if (sm.session.communicator.uuid)
                esl.executeAsyncX('eval', ['${originate ' + originate + ' &park}'], sm.session.communicator.uuid, this);
            else
                esl.bgapiX('originate', [originate, '&park'], this);

        });

        return this;
    },
    parked: function onConsumerSimpleParked(evt) { // originate has completed
        debug(this.session.sid, 'parked:');
        if (evt.type === 'BACKGROUND_JOB') // bgapiX-originate spawned - no communicator to bridge to
            return this;
        else if (evt.type !== 'CHANNEL_EXECUTE_COMPLETE') // executeAsyncX-originate failed
            return this.signal('cleanup') || this;

        var sm = this;
        chain(function cleanup(err, evt) {
            err && console.log(sm.session.sid, 'onConsumerSimpleParked:', err);
            if (evt.headers['Application-Data']) // required as uuid_bridge is executed using eval
                evt.body = evt.headers['Application-Data'];
            sm.signal('bridged', evt);

        }, function (evt) {
            debug(sm.session.sid, 'parked.1:', 'uuid_bridge', sm.uuid, sm.session.communicator.uuid || 'fake');
            if (!sm.session.communicator.uuid)
                return this(null, evt); // spoof the uuid_bridge outcome

            esl.executeAsyncX('eval', ['${uuid_bridge ${uuid} ' + sm.session.communicator.uuid + '}'], sm.uuid, this);

        });
        return this;
    },
    bridged: function onConsumerSimpleBridged(evt) { // bridge has completed
        debug(this.session.sid, 'bridged:');
        if (evt.type !== 'CHANNEL_EXECUTE_COMPLETE') // ultimately unsuccessful
            return this.signal('cleanup') || this;

        this.bridged = true;
        return this;
    },
    CHANNEL_CREATE: function onConsumerSimpleChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[this.uuid = evt.headers['Unique-ID']] = true;
        return this;
    },
    CHANNEL_: function onConsumerSimpleChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':');
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.signal('answer'); // needed for Oysta reporting
        return this;
    },
    CHANNEL_DESTROY: function onConsumerSimpleChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'bridged =', this.bridged);
        this.uuids[evt.headers['Unique-ID']] = false;

        var legs = 0;
        for (var uuid in this.uuids)
            legs += this.uuids[uuid];
        if (!legs) // all legs cleaned-up
            this.session.signal('consume', this.bridged); // try next consumer OR task;
        return this;
    },
    CUSTOM: function onCommunicatorSimpleCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorSimpleTone(evt, first) {
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorSimpleDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorSimpleMessage(evt, first) {
        debug(this.session.sid, 'MESSAGE:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
});
