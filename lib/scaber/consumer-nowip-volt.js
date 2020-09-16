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
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = ConsumerNowipVolt;

require('util').inherits(ConsumerNowipVolt, require('../state-machine'));
function ConsumerNowipVolt(session, uris) {
    if (this instanceof ConsumerNowipVolt === false)
        throw new Error('Constructor ConsumerNowipVolt requires \'new\'');
    ConsumerNowipVolt.super_.call(this, consumerState, {
        bridged: false, // used to track whether the caller was bridged to the arc
        dty: undefined, // capture '####' scaip value for translation to nowip
        lco: undefined, // capture '###' scaip value for translation to nowip
        leaving: 0, // used to prevent recursive calls to state:leave method
        sent: false, // tracks whether the nowip ATM message has been sent to the arc
        session: session, // a reference to the owning session
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: {}, // { uuid: boolean } collection of active outbound channel-ids
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
        for (var uuid in this.uuids)
            this.uuids[uuid] && esl.bgapiX('uuid_kill', [uuid]);
    },
    cleanup: function onConsumerNowipVoltCleanup(err, evt) {
        debug(this.session.sid, 'cleanup: bridged =', this.bridged, callsites()[2].toString());
        var legs = 0;
        for (var uuid in this.uuids)
            if (this.uuids[uuid])
                legs++, esl.bgapiX('uuid_kill', [uuid]);
        if (!legs) // all legs cleaned-up
            this.session.signal('consume', this.bridged); // try next consumer OR task;
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
            return debug(this.session.sid, 'activate:', this.uris, callsites()[2].toString());

        if (!this.session.payload.ATM && !this.session.payload.mrq) { // non-NOWIP / non-SCAIP communicator
            debug(this.session.sid, 'activate:', this.uris, callsites()[2].toString());

        } else if (!configs && this.session.payload.mrq) { // SCAIP communicator - need to create NOWIP payload
            var mrq = this.session.payload.mrq, wheres = this.wheres = [];
            this.dty = ('0000' + +mrq.dty[0]).slice(-4);
            this.stc = ('0000' + +mrq.stc[0]).slice(-4);
            this.lco = ('000' + +mrq.lco[0]).slice(-3);
            wheres.push(
                '/scaip/cid/' + this.session.origin + '/nowip',
                '/scaip/dty/' + this.dty + '/nowip',
                '/scaip/lco/' + this.lco + '/nowip',
                '/scaip/dtylco/' + this.dty + this.lco + '/nowip',
            );

            debug.enabled && debug(this.session.sid, 'activate', JSON.stringify({ dty: this.dty, lco: this.lco }), callsites()[2].toString());
            var cb = Object.assign(this.signal.bind(this, 'activate'), { index: this.session.sid });
            return mysql('select * from config where schemeId=0 and nameSlashed in (' + mysql.qmks(wheres) + ') order by valueNumber,length(nameSlashed)', wheres, cb);

        } else if (configs) { // SCAIP translation rows to create NOWIP payload
            var atm = {}, unknowns = ['event', 'location'];
            for (var i in configs)
                Object.assign(atm, JSON.parse(configs[i].valueString));
            var unknowns = ['event', 'location'].filter(function (attr, idx, arr) { return attr in this === false }, atm);
            unknowns.length && console.log('SCAIP-NOWIP unknown', JSON.stringify({ UNKNOWNS: unknowns, dty: this.dty, lco: this.lco }));
            this.session.payload.ATM = {
                data: [nowip.stringify(atm = Object.assign({
                        controllerunit: ('000000000000' + this.session.origin).slice(-12),
                    }, atm))],
            };
            debug(this.session.sid, 'activate', JSON.stringify({ atm: atm, data: this.session.payload.ATM.data }));
            this.session.payload.mrq.geo && (this.session.payload.ATM.wgs = [this.session.payload.mrq.geo]);    // non-standard NOWIP item
        }

        var origin = (this.session.payload.ATM || { data: [''] }).data[0].slice(4, 16).replace(/^0+/, '');
        esl.bgapiX('originate', [esl.nvp({
            //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
            appello_consumer: !undefined, // true as this is a consumer leg
            appello_unique: this.session.unique,
            drop_dtmf: true,
            fs_send_unsupported_message: true, // enables uuid_send_message
            originate_continue_on_timeout: true,
            originate_timeout: 15,
            origination_caller_id_name: this.session.firstEvt.headers['Caller-Caller-ID-Name'] || '_undef_',
            origination_caller_id_number: origin || this.session.origin,
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
