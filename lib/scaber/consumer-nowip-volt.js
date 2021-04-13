#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('consumer:nowip:volt');
var esl = require('../esl');
var js2xml = new (require('xml2js')).Builder({ headless: true, renderOpts: null });
var main = require.main.exports;
var mysql = require('../mysql');
var nowip = require('../nowip');
var transform = require('./transform');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = ConsumerNowipVolt;

require('util').inherits(ConsumerNowipVolt, require('../state-machine'));
function ConsumerNowipVolt(session, uris) {
    if (this instanceof ConsumerNowipVolt === false)
        throw new Error('Constructor ConsumerNowipVolt requires \'new\'');

    ConsumerNowipVolt.super_.call(this, ConsumerNowipVolt, {
        bridged: false, // used to track whether the caller was bridged to the arc
        dtmf: '', // received tone accumulator
        lastIndex: 0, // next AX regex scanning index
        leaving: 0, // used to prevent recursive calls to state:leave method
        sent: false, // tracks whether the nowip ATM message has been sent to the arc
        session: session, // a reference to the owning session
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: {}, // { uuid: boolean } collection of active outbound channel-ids
    });
}

Object.assign(ConsumerNowipVolt, {// _this_ of all methods is the StateMachine instance
    AX: /a([0-9A-D*#])/g, // regex to match speech commands - speak=[A]7, listen=[A]8, clear=[A]9, close=[A]D, null=[A]#,
    controls: ',,,,,,,pathSpeak,pathListen,pathClear,,,,pathClose,,pathNull'.split(','),

    enter: function onConsumerNowipVoltEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerNowipVoltLeave() {
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
    cleanup: function onConsumerNowipVoltCleanup(err, evt) {
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
    activate: function onConsumerNowipVoltActivate() { // multiple activations by session each time round the list of consumers
        debug.enabled && debug(this.session.sid, 'activate:', JSON.stringify(this.uris), callsites()[2].toString());
        this.bridged = this.sent = false; // reset to false on activation
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
                console.log(this.session.id, 'onConsumerNowipVoltActivate-Error: target URI(s) required');
            return this.session.signal('consume', false);
        }

        var sm = this;
        chain(function cleanup(err, evt) {
            err && console.log(sm.session.sid, 'onConsumerNowipVoltActivate:', err)
            sm.signal('parked', evt);

        }, function () {
            this.index = sm.session.sid; // enable transform to tag mysql transactions
            transform.atm.call(sm.session, sm.session.payload, this); // provide session as _this_

        }, function (payload) {
            if (!sm.session.payload.ATM)
                return this();

            debug(sm.session.sid, 'activate:', 'rename recording to append NOWIP', sm.session.payload.ATM.data[0]);
            esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} ' + sm.session.payload.ATM.data[0]], sm.session.communicator.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'activate:', 'originate', sm.uris);
            var originUser = sm.session.payload.originUser || sm.session.payload.e164;
            sm.session.signal('route', [originUser]);
            esl.bgapiX('originate', [esl.nvp({
                    //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
                    appello_consumer: !undefined, // true as we are a consumer leg
                    appello_unique: sm.session.unique,
                    drop_dtmf: true,
                    //fs_send_unsupported_message: true, // enables uuid_send_message
                    originate_continue_on_timeout: true,
                    originate_timeout: 15,
                    //origination_caller_id_name: sm.session.firstEvt.headers['Caller-Caller-ID-Name'] || '_undef_',
                    origination_caller_id_name: sm.session.payload.ATM ? sm.session.payload.ATM.data[0] : '_undef_',
                    origination_caller_id_number: originUser,
                    //origination_privacy: 'screen:hide_number',
                }, '{}' + sm.uris), '&park'], this);

        });

        return this;
    },
    parked: function onConsumerNowipVoltParked(evt) { // originate has completed
        debug(this.session.sid, 'parked:', evt && evt.body.replace(/\s+$/, ''));
        var match = evt && evt.body.match(/^\+OK\s+([-\w]+)/);
        if (!match) // ultimately unsuccessful
            return this.signal('cleanup') || this;

        var sm = this;
        chain(function cleanup(err, evt) {
            err && console.log(sm.session.sid, 'onConsumerNowipVoltParked:', err);
            sm.signal('bridged', evt);

        }, function (evt) {
            if (!sm.session.payload.ATM)
                return this();

            // set the caller-name sent via INFO on bridge
            esl.executeAsyncX('set_profile_var', ['caller_id_name=' + sm.session.payload.ATM.data[0]], sm.session.communicator.uuid, this);

        }, function () {
            debug(sm.session.sid, 'parked:', 'uuid_bridge');
            esl.bgapiX('uuid_bridge', [match[1], sm.session.communicator.uuid], this);

        });
        return this;
    },
    bridged: function onConsumerNowipVoltBridged(evt) { // bridge has completed
        debug(this.session.sid, 'bridged:', evt && evt.body.replace(/\s+$/, ''));
        if (!evt.body.startsWith('+OK')) // ultimately unsuccessful
            return this.signal('cleanup') || this;
        this.bridged = true;
        return this;
    },
    CHANNEL_CREATE: function onConsumerNowipVoltChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[evt.headers['Unique-ID']] = true;
        return this;
    },
    CHANNEL_: function onConsumerNowipVoltChannel(evt, first) { // miscellaneous CHANNEL_*** events
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.signal('answer');
        if (this.sent || !this.session.payload.ATM || !['CHANNEL_PROGRESS', 'CHANNEL_PROGRESS_MEDIA', 'CHANNEL_ANSWER'].includes(evt.type))
            return debug(this.session.sid, evt.type + ':') || this;
        this.sent = true;
        var atm = {
            type: 1,
            data: this.session.payload.ATM.data[0],
            e164: this.session.payload.e164 && '+' + this.session.payload.e164, // non-standard NOWIP item
            wgs: (this.session.payload.ATM.wgs || [])[0],   // non-standard NOWIP item
            blocking: true
        };
        esl.atm(evt, atm);
        /// better to use uuid_send_message as the sip_profile and protocol(udp/tdp/tls) are automatically in-line with the INVITE
        /// - but an in-dialog MESSAGE seems to upset the OASIS/Carenet where the Call-ID of the MESSAGE is the same as the INVITE
        //esl.bgapiX('uuid_send_message', [evt.headers['Unique-ID'], atm.xml = js2xml.buildObject({ // uuid_send_message requires fs_send_unsupported_message=true on the originate
        //    ATM: {
        //        version: ['1.5'],
        //        type: ['1'],
        //        data: this.session.payload.ATM.data,
        //        time: [new Date().toJSON().slice(11, 19)],
        //        mac: [main.config.mac],
        //        wgs: this.session.payload.ATM.wgs || [],
        //    }
        //})]); // console.log.bind(0, 'onConsumerNowipVoltChannel:')
        debug(this.session.sid, evt.type + ':', atm.xml);
        return this;
    },
    CHANNEL_DESTROY: function onConsumerNowipVoltChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'bridged =', this.bridged);
        this.uuids[evt.headers['Unique-ID']] = false;
        if (+evt.headers['variable_bridge_uepoch']) // bridged & released
            return this.signal('cleanup') || this;

        var legs = 0;
        for (var uuid in this.uuids)
            legs += this.uuids[uuid];
        if (!legs) // all legs cleaned-up
            this.session.signal('consume', this.bridged); // try next consumer OR task;
        return this;
    },
    CUSTOM: function onCommunicatorNowipVoltCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorNowipVoltTone(evt, first) {
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorNowipVoltDtmf(evt, first) {
        var durationMs = evt.headers['DTMF-Duration'] / 8, match, control, tone;
        this.dtmf += ('AB'.includes(evt.headers['DTMF-Digit']) && durationMs > 200) ? evt.headers['DTMF-Digit'].toLowerCase() : evt.headers['DTMF-Digit'];
        ConsumerNowipVolt.AX.lastIndex = this.lastIndex;
        while (match = ConsumerNowipVolt.AX.exec(this.dtmf)) {
            this.lastIndex = ConsumerNowipVolt.AX.lastIndex;
            if (control = ConsumerNowipVolt.controls['0123456789ABCD*#'.indexOf(match[1])])
                break;
        }
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.dtmf, control);
        return this;
    },
    MESSAGE: function onConsumerNowipVoltMessage(evt, first) { // received NOWIP ack
        var err, mandatory = new Set(['version', 'type', 'data', 'time', 'mac']);
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], evt.body);
        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
        if (!err) {
            mandatory.forEach(function (key, idx, arr) { key in this && arr.delete(key) }, evt.parsed.ATM || {});
            mandatory.size && (err = Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
        }
        if (err)
            return console.log(this.session.sid, 'onConsumerNowipVoltMessage:', err) || this;

        evt.parsed && (this.ackd = (((evt.parsed.ATM || {}).type || [])[0] === 'A'));
        return this;
    },
});
