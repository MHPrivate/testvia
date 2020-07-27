#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('consumer:nowip:volt');
var esl = require('../esl');
var js2xml = new (require('xml2js')).Builder({ headless: true, renderOpts: null });
var main = require.main.exports;
var mysql = require('../mysql');
var nowip = require('../nowip');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = ConsumerNowipVolt;

require('util').inherits(ConsumerNowipVolt, require('../state-machine'));
function ConsumerNowipVolt(session, uris) {
    if (this instanceof ConsumerNowipVolt === false)
        throw new Error('Constructor ConsumerNowipVolt requires \'new\'');
    ConsumerNowipVolt.super_.call(this, consumerState, {
        bridged: false, // used to track whether the caller was bridged to the arc
        dtystc: undefined, // capture 'NNNNMMMM' scaip values for translation to nowip
        leaving: 0, // used to prevent recursive calls to state:leave method
        sent: false, // tracks whether the nowip ATM message has been sent to the arc
        session: session, // a reference to the owning session
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: new Set, // collection of active outbound channel-ids
    });
}

var consumerState = {// _this_ of all methods is the StateMachine instance
    enter: function onConsumerNowipVoltEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerNowipVoltLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        Array.from(this.uuids).forEach(function (uuid, idx, arr) {
            esl.bgapiX('uuid_kill', [uuid]);
        });
    },
    cleanup: function onConsumerNowipVoltCleanup(err, evt) {
        debug(this.session.sid, 'cleanup:');
        if (!this.uuids.size)
            return this.session.signal('consume', this.bridged) || this; // try next consumer OR task;
        Array.from(this.uuids).forEach(function (uuid, idx, arr) {
            esl.bgapiX('uuid_kill', [uuid]);
        });
        return this;
    },
    activate: function onConsumerNowipVoltActivate(err, configs, meta) { // multiple activations by session each time round the list of consumers
        err && console.log('onComsumerNowipVoltActivate:', err); // mysql error
        this.bridged = this.sent = false; // reset to false on activation
        if (Array.isArray(this.uris)) { // convert array of {scheme,user,password,host,port,params,headers} to dialstring
            if (this.constructor.name in main.state)
                this.uris.push.apply(this.uris, this.uris.splice(0, ++main.state[this.constructor.name] % this.uris.length));
            else
                main.state[this.constructor.name] = 0;
            this.uris = esl.dialstring(this.uris);
        }
        if (!this.uris)
            return debug(this.session.sid, 'activate:', this.uris);

        if (configs) { // [{id,nameSlashed,valueBoolean,valueNumber,valueString:JSON}] response from mysql - see 12 lines below
            configs.length || console.log(this.session.sid, 'onConsumerNowipVoipActivate: UNKNOWN dtystc', this.dtystc);
            this.session.payload.ATM = {
                data: [nowip.stringify(Object.assign({
                        controllerunit: (this.session.callerId[2] + '000000000000').slice(0, 12),
                        status: 'Non-speech manually operated',
                    }, JSON.parse((configs[0] || {}).valueString || null)))], // JSON:{_dty:string,_stc:string,event:number,location:number}
            };
            this.session.payload.mrq.geo && (this.session.payload.ATM.wgs = [this.session.payload.mrq.geo]);
            debug(this.session.sid, 'activate', JSON.stringify({ data: this.session.payload.ATM.data }));
        } else if (!this.session.payload.ATM && this.session.payload.mrq) { // need to construct a NOWIP message from a SCAIP message
            this.dtystc = ('0000' + +this.session.payload.mrq.dty).slice(-4) + ('0000' + +this.session.payload.mrq.stc).slice(-4);
            debug.enabled && debug(this.session.sid, 'activate', JSON.stringify({ dtystc: this.dtystc }));
            var cb = Object.assign(this.signal.bind(this, 'activate'), { index: this.session.sid });
            return mysql('select * from config where schemeId=0 and nameSlashed=?', ['/scaip/dtystc/' + this.dtystc + '/nowip'], cb);
        } else {
            debug(this.session.sid, 'activate:', this.uris);
        }

        esl.bgapiX('originate', [esl.nvp({
            //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
            appello_consumer: !undefined, // true as this is a consumer leg
            appello_unique: this.session.unique,
            fs_send_unsupported_message: true, // enables uuid_send_message
            originate_continue_on_timeout: true,
            originate_timeout: 15,
            origination_caller_id_name: this.session.firstEvt.headers['Caller-Caller-ID-Name'] || '_undef_',
            origination_caller_id_number: this.session.origin,
        }, '{}' + this.uris), '&park'], this.signal.bind(this, 'parked'));

        return this;
    },
    parked: function onConsumerNowipVoltParked(err, evt) { // originate has completed
        debug(this.session.sid, 'parked:', evt.body.replace(/\s+$/, ''));
        var match = evt.body.match(/^\+OK\s+([-\w]+)/);
        if (!match) // ultimately unsuccessful
            return this.signal('cleanup') || this;
        esl.bgapiX('uuid_bridge', [match[1], this.session.communicator.uuid], this.signal.bind(this, 'bridged'));
        return this;
    },
    bridged: function onConsumerNowipVoltBridged(err, evt) { // bridge has completed
        debug(this.session.sid, 'bridged:', evt.body.replace(/\s+$/, ''));
        if (!evt.body.startsWith('+OK')) // ulitimately unsuccessful
            return this.signal('cleanup') || this;
        this.bridged = true;
        return this;
    },
    CHANNEL_CREATE: function onConsumerNowipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids.add(evt.headers['Unique-ID']);
        return this;
    },
    CHANNEL_: function onConsumerNowipVoltChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':');
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.signal('answer');
        if (!nowip || this.sent || !['CHANNEL_PROGRESS', 'CHANNEL_PROGRESS_MEDIA', 'CHANNEL_ANSWER'].includes(evt.type))
            return this;
        this.sent = true;
        //return esl.atm(evt, { type: 1, data: this.session.payload.ATM.data[0], wgs: (this.session.payload.ATM.wgs || [])[0], blocking: true }) || this;
        esl.bgapiX('uuid_send_message', [evt.headers['Unique-ID'], js2xml.buildObject({ // uuid_send_message requires fs_send_unsupported_message=true on the originate
            ATM: {
                version: ['1.5'],
                type: ['1'],
                data: this.session.payload.ATM.data,
                time: [new Date().toJSON().slice(11, 19)],
                mac: [main.config.mac],
                wgs: this.session.payload.ATM.wgs || [],
            }
        })]); // console.log.bind(0, 'onConsumerNowipVoltChannel:')
        return this;
    },
    CHANNEL_DESTROY: function onConsumerNowipVoltChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:');
        this.uuids.delete(evt.headers['Unique-ID']);
        if (+evt.headers['variable_bridge_uepoch']) // bridged & released
            return this.signal('cleanup') || this;
        if (!this.uuids.size) // all legs cleaned-up
            this.session.signal('consume', this.bridged);
        return this;
    },
    MESSAGE: function onConsumerNowipVoltMessage(evt, first) { // received NOWIP ack
        var err, mandatory = new Set(['version', 'type', 'data', 'time', 'mac']);
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], evt.body);
        if (this.ackd)
            return this;

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
};
