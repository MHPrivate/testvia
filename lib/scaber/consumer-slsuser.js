#! /usr/bin/env node-strict
var callsites = require('callsites');
var chain = require('scope-chain');
var debug = require('debug')('consumer:slsuser');
var esl = require('../esl');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mysql = require('../mysql');
var os = require('os');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = ConsumerSlsUser;

require('util').inherits(ConsumerSlsUser, require('../state-machine'));
function ConsumerSlsUser(session) {
    if (this instanceof ConsumerSlsUser === false)
        throw new Error('Constructor ConsumerSlsUser requires \'new\'');

    ConsumerSlsUser.super_.call(this, ConsumerSlsUser, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        slsuser: undefined, // pending target
        timeout: undefined,
        uuid: undefined, // currently active outbound channel-id
        uuids: {}, // { uuid: slsuser } catalogue outbound channel-ids
    });
}

Object.assign(ConsumerSlsUser, { // _this_ of all methods is the StateMachine instance
    doorRelease: '*@200',

    enter: function onConsumerSlsUserEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerSlsUserLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        if (this.uuid)
            esl.executeAsyncX('hangup', [], this.uuid);
        this.timeout = worker.resetTimeout(this.timeout);
    },
    activate: function onConsumerSlsUserActivate(slsuser) { // { from_name, from_number, privacy, to_number }
        debug.enabled && debug(this.session.sid, 'activate:', JSON.stringify(slsuser), callsites()[2].toString());
        if (typeof slsuser === 'string')
            return this.signal(slsuser);

        var sm = this;
        chain(sm.session.sid + ' onConsumerSlsUserActivate:', function () {
            this.index = sm.session.sid;
            mysql('select * from sipUsers where name="registration" and user=substring(?,1,length(user)) order by length(user) desc', [slsuser.to_number], this);

        }, function (sipUsers, meta) {
            try {
                this.sipUser = sipUsers && sipUsers.length && JSON.parse(sipUsers[0].value);
            } catch (ex) {
                console.log(sm.session.sid, 'onConsumerSlsUserActivate:', ex.message, sipUsers[0].value);
                return sm.session.signal('consume', true);
            }
            if ((this.sipUser || { expires: 0 }).expires * 1000 < Date.now())
                return sm.session.signal('consume', true);

            if (this.sipUser.hostname !== os.hostname()) // need to expedite via another host
                this.originate = esl.nvp({
                    absolute_codec_string: slsuser.codec,
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.sid,
                    origination_caller_id_name: slsuser.from_name,
                    origination_caller_id_number: slsuser.from_number,
                    origination_privacy: slsuser.privacy,
                    rtp_secure_media: true,
                    'sip_h_X-AppelloExpedite': jwt.sign({
                        byps: false, // bypass_media - can do something clever with this to improve the media path
                        dest: slsuser.to_number,
                        name: slsuser.from_name,
                        numb: slsuser.from_number,
                        priv: slsuser.privacy,
                        prfx: this.sipUser.reg_user,
                    }, main.cache.tls.key, { algorithm: 'HS256' }), // symetric signing using key gives a shorted JWT
                }, '{}' + 'sofia/ext4tls/' + slsuser.to_number + '@' + this.sipUser.hostname + ':5061;transport=tls');
            else // originate to local-user
                this.originate = esl.nvp({
                    absolute_codec_string: slsuser.codec,
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.sid,
                    origination_caller_id_name: slsuser.from_name,
                    origination_caller_id_number: slsuser.from_number,
                    origination_privacy: slsuser.privacy,
                    rtp_secure_media: !!this.sipUser.url.match(/transport=tls/i),
                }, '{}' + this.sipUser.url.replace('sip:', 'sofia/' + this.sipUser.profile + '/').replace(/gw\+[^@]+/, slsuser.to_number));

            debug(sm.session.sid, 'activate:', 'originate', this.originate);
            // must use originate+uuid_bridge as dptool-bridge leads to temperamental behaviour
            esl.executeAsyncX('eval', ['${originate ' + this.originate + ' &park()}'], sm.session.communicator.uuid, this); // instead of bgapiX

        });

        return this;
    },
    atmCommandControlRelease1: function () {
        debug(this.session.sid, 'atmCommandControlRelease1:', 'send_dtmf', ConsumerSlsUser.doorRelease);
        esl.executeAsyncX('send_dtmf', [ConsumerSlsUser.doorRelease], this.uuid);
    },
    atmCommandControlRelease2: function () {
        debug(this.session.sid, 'atmCommandControlRelease2:', 'send_dtmf', ConsumerSlsUser.doorRelease);
        esl.executeAsyncX('send_dtmf', [ConsumerSlsUser.doorRelease], this.uuid);
    },
    atmCommandControlReleaseKeysafe: function () {
        debug(this.session.sid, 'atmCommandControlReleaseKeysafe:', 'send_dtmf', ConsumerSlsUser.doorRelease);
        esl.executeAsyncX('send_dtmf', [ConsumerSlsUser.doorRelease], this.uuid);
    },
    atmCommandControlReleaseAll: function () {
        debug(this.session.sid, 'atmCommandControlReleaseAll:', 'send_dtmf', ConsumerSlsUser.doorRelease);
        esl.executeAsyncX('send_dtmf', [ConsumerSlsUser.doorRelease], this.uuid);
    },
    CHANNEL_CREATE: function onConsumerSlsUserChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[this.uuid = evt.headers['Unique-ID']] = evt.headers['Caller-Destination-Number'];
        return this;
    },
    CHANNEL_: function onConsumerSlsUserChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':');
        var sm = this;
        if (evt.type === 'CHANNEL_ANSWER') {
            chain(function cleanup(err) {
                err && console.log(sm.session.sid, 'onConsumerSlsUserChannel:', err);

            }, function () {
                debug(sm.session.sid, 'CHANNEL_ANSWER:', 'uuid_bridge', sm.session.communicator.uuid, sm.uuid);
                // must use originate+uuid_bridge as dptool-bridge leads to temperamental behaviour
                esl.executeAsyncX('eval', ['${uuid_bridge ' + sm.session.communicator.uuid + ' ${uuid}}'], sm.uuid, this); // instead of bgapiX

            });
        }
        return this;
    },
    CHANNEL_DESTROY: function onConsumerSlsUserChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        this.uuid = undefined;
        return this;
    },
    CUSTOM: function onCommunicatorSlsUserCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorSlsUserTone(evt, first) {
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorSlsUserDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorSlsUserMessage(evt, first) {
        debug(this.session.sid, 'MESSAGE:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
});
