#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('consumer:nowip:volt');
var esl = require('../esl');
var js2xmlInfo = new (require('xml2js')).Builder({ renderOpts: null, xmldec: { encoding: 'UTF-8' } });
var js2xmlMesg = new (require('xml2js')).Builder({ headless: true, renderOpts: null });
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
    command: {
        '0':  'Sundry',   // SundryPayload
        '1':  'Clear',    // ClearChildCall
        '2':  'Close',    // ClearCall
        '3':  'Listen',   // SetDeviceSpeechStateListen
        '4':  'Speak',    // SetDeviceSpeechStateSpeak
        '5':  'Simplex',  // SetDeviceSpeechModeSimplex
        '6':  'Duplex',   // SetDeviceSpeechModeDuplex
        '7':  'Choose',   // ClearAndConnectAlarmDeviceChildCall
        '8':  'Connect',  // ConnectAlarmDeviceToNewChildCall
        '10': 'Update',   // UpdateAlarmDeviceDigits ???
    },
    control: {
        '01': 'Release1',
        '02': 'Release2',
        '03': 'ReleaseKeysafe',
        '04': 'ReleaseAll',
        '05': 'Undefined',
        '06': 'Relay1On',
        '07': 'Relay1Off',
        '08': 'Relay2On',
        '09': 'Relay2Off',
        '10': 'SwitchLocal',
        '11': 'SwitchARC',
        '12': 'SwitchPerson',
        '13': 'InactivityOn',
        '14': 'InactivityOff',
        '15': 'IntruderOn',
        '16': 'IntruderOff',
        '17': 'ColdOn',
        '18': 'ColdOff',
        '19': 'TempOn',
        '20': 'TempOff',
        '21': '+1hr',
        '22': '-1hr',
        '23': 'ResetStatus',
        '24': 'Inactivity',
        '25': 'Systest',
        '30': 'Suspend',
        '31': 'Resume',
        '32': 'Exit',
    },
    controls: ',,,,,,,pathSpeak,pathListen,pathClear,,,,pathClose,,pathNull'.split(','),
    param: {
        '001': 'Arc1',
        '002': 'Arc2',
        '003': 'Arc3',
        '004': 'Arc4',
        '005': 'Person5',
        '006': 'Person6',
        '007': 'Person7',
        '008': 'Person8',
        '009': 'Sequence',
        '010': 'Redials',
        '011': 'PreDelay',
        '012': 'UnitId1',
        '013': 'UnitId2',
        '014': 'User1',
        '015': 'User2',
        '016': 'User3',
        '017': 'User4',
        '018': 'Pin',
        '019': 'Loudspeaker',
        '020': 'Speech',
        '021': 'AutoAnswer',
        '022': 'IntruderDelay',
        '023': 'ReassuranceTone',
        '024': 'DialMode',
        '025': 'Time',
        '026': 'PhoneWarning',
        '027': 'MainsWarning',
        '028': 'PeriodicDays',
        '029': 'AwayMode',
        '030': 'SystemType',
        '031': 'EquipmentId',
    },
    quick: {
        '7': 'Speak', // ack: B
        '8': 'Listen', // ack: B
        '9': 'Clear', // status: A000000#
        'D': 'Close', // ack: B
        '#': 'Null', // ack: B ????
    },
    speech: {
        '0': 'Reset',
        '1': 'Volume1',
        '2': 'Volume2',
        '3': 'Volume3',
        '4': 'VolumeUp',
        '5': 'VolumeDn',
        '6': 'Speaker1',
        '7': 'Speaker2',
        '8': 'Duplex',
        '9': 'Simplex',
    },

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
        this.bridged = !this.session.communicator.uuid; // fake bridged when no Communicator
        this.sent = false; // reset to false on activation
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
            var suffix = (payload.ATM || { data: ['unknown'] }).data[0];
            debug(sm.session.sid, 'activate:', 'rename recording to append NOWIP', suffix);
            if (sm.session.communicator.uuid)
                esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} ' + suffix], sm.session.communicator.uuid, this);
            else
                esl.bgapiX('expand', ['bg_system $${conf_dir}/bin/add-suffix.sh $${recordings_dir}/${strftime(%Y-%m-%dT%H-%M-%SZ)}.novoice.wav ' + suffix], this);

        }, function (evt) {
            if (!sm.session.communicator.uuid && !(sm.session.payload.atm || {}).event) {
                console.log('onConsumerNowipVoltActivate: zero ATM.event - ABORTING Consumer', JSON.stringify(sm.session.payload));
                return sm.signal('cleanup');
            }

            var originUser = sm.session.payload.originUser || sm.session.payload.e164;
            var originate = esl.nvp({
                //absolute_codec_string: 'PCMU\\,PCMA\\,H264', // fails to include video within INVITE
                appello_consumer: !undefined, // true as we are a consumer leg
                appello_unique: sm.session.sid,
                drop_dtmf: true,
                fs_send_unsupported_info: true, // enables dp:send_info & uuid_send_info
                fs_send_unsupported_message: true, // enables uuid_send_message
                originate_continue_on_timeout: true,
                originate_timeout: 15,
                //origination_caller_id_name: sm.session.firstEvt.headers['Caller-Caller-ID-Name'] || '_undef_',
                origination_caller_id_name: sm.session.payload.ATM ? sm.session.payload.ATM.data[0] : '_undef_',
                origination_caller_id_number: originUser,
                //origination_privacy: 'screen:hide_number',
                'sip_h_Info-Package': 'X-CDS-Telecare',
                'sip_info_h_Info-Package': 'X-CDS-Telecare',
            }, '{}' + sm.uris);

            debug(sm.session.sid, 'activate:', 'originate', originate);
            esl.bgapiX('originate', [originate, '&park'], this);

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
            if (evt.headers['Application-Data']) // required as uuid_bridge is executed using eval
                evt.body = evt.headers['Application-Data'];
            sm.signal('bridged', evt);

        }, function (evt) {
            if (!sm.session.payload.ATM || !sm.session.communicator.uuid)
                return this();

            // set the caller-name sent via INFO on bridge
            esl.executeAsyncX('set_profile_var', ['caller_id_name=' + sm.session.payload.ATM.data[0]], sm.session.communicator.uuid, this);

        }, function () {
            debug(sm.session.sid, 'parked:', 'uuid_bridge', sm.uuid, sm.session.communicator.uuid || 'fake');
            if (!sm.session.communicator.uuid)
                return this(null, evt); // spoof the uuid_bridge outcome

            esl.executeAsyncX('eval', ['${uuid_bridge ${uuid} ' + sm.session.communicator.uuid + '}'], sm.uuid, this);

        });
        return this;
    },
    bridged: function onConsumerNowipVoltBridged(evt) { // bridge has completed
        debug(this.session.sid, 'bridged:', evt ? evt.body.replace(/\s+$/, '') : 'faked');
        if (evt && !evt.body.startsWith('+OK')) // ultimately unsuccessful
            return this.signal('cleanup') || this;
        this.bridged = true;
        return this;
    },
    CHANNEL_CREATE: function onConsumerNowipVoltChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[this.uuid = evt.headers['Unique-ID']] = true;
        return this;
    },
    CHANNEL_: function onConsumerNowipVoltChannel(evt, first) { // miscellaneous CHANNEL_*** events
        //if (evt.type === 'CHANNEL_ANSWER')
        //    this.session.signal('answer'); // done automatically by the freeswitch-bridge
        if (this.sent || !this.session.payload.ATM || !['CHANNEL_PROGRESS', 'CHANNEL_PROGRESS_MEDIA', 'CHANNEL_ANSWER'].includes(evt.type))
            return debug(this.session.sid, evt.type + ':') || this;

        this.sent = true;
        var xml = js2xmlMesg.buildObject({ // uuid_send_message *** REQUIRES *** fs_send_unsupported_message=true on the originate
            ATM: {
                version: ['1.5'],
                type: ['1'],
                data: this.session.payload.ATM.data,
                time: [new Date().toJSON().slice(11, 19)],
                mac: [main.config.mac],
                e164: this.session.payload.e164 ? '+' + this.session.payload.e164 : [],
                wgs: this.session.payload.ATM.wgs || [],
            },
        });
        debug(this.session.sid, evt.type + ':', xml);
        esl.executeAsyncX('eval', ['${uuid_send_message ${uuid} ' + xml + '}'], this.uuid);


        return this;
    },
    CHANNEL_DESTROY: function onConsumerNowipVoltChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', 'bridged =', this.bridged);
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
            evt.parsed = Object.assign(err || js, { xml: evt.body });
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
    RECV_INFO: function onConsumerNowipVoltInfo(evt, first) { // received INFO
        var err;
        debug(this.session.sid, 'INFO:', evt.headers['Event-Sequence'], evt.body);
        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = Object.assign(err || js, { xml: evt.body });
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
        if (err)
            return console.log(this.session.sid, 'onConsumerNowipVoltInfo:', err) || this;

        var cmdN = (evt.parsed.CDSTelecare || { Command: [] }).Command[0];
        isNaN(cmdN) || this.signal('arcCommand' + cmdN, evt, first) || this.signal('arcCommand', cmdN, evt, first);
        return this;
    },
    arcCommand: function onArcCommand(cmdN, evt, first) { // generic command handler
        var command = ConsumerNowipVolt.command[cmdN];
        debug(this.session.sid, 'arcCommand:', command || cmdN);
        if (!command)
            return this;

        this.session.signal('communicator', 'arcCommand', command, cmdN, function arcCommandCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || '', $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcCommandCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid, function (err) {
                if (cmdN === '2')
                    this.signal('cleanup');
            }.bind(this));
        }.bind(this));
    },
    arcCommand0: function onArcCommandSundryPayload(evt, first) { // specific Command0 handler
        var match, digits = (evt.parsed.CDSTelecare || { Digits: [] }).Digits[0];
        for (var cmd in ConsumerNowipVolt) {
            if (cmd[0] !== '/') // regex indicator
                continue;
            if (!ConsumerNowipVolt[cmd].re)
                ConsumerNowipVolt[cmd].re = new RegExp(cmd.slice(1));
            if (!(match = digits.match(ConsumerNowipVolt[cmd].re)))
                continue;
            this.signal(cmd, evt, match);
            break;
        }
        match || debug(this.session.sid, 'arcCommand0:', ConsumerNowipVolt.command['0'], data);
        return this;
    },
    '/T250:80:AT80:80:(?<quick>.)': function onArcQuick(evt, match) { // generalised BS8521 [A]n handler
        var ballast = '', quick = ConsumerNowipVolt.quick[match[1]];
        if (!evt.parsed.CDSTelecare.Response)
            return debug(this.session.sid, 'arcQuick:', quick);

        if ('9'.includes(match[1])) // send STATUS
            ballast = 'A000000#';
        else if ('78D#'.includes(match[1])) // send ACK
            ballast = 'B';
        if (!ballast)
            return debug(this.session.sid, 'arcQuick:', quick, '?' + match[1]);

        debug.enabled && debug(this.session.sid, 'arcQuick:', quick, JSON.stringify(match))
        this.session.signal('communicator', 'arcQuick', quick, match, function arcQuickCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcQuickCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/B': function onArcAcknowledge(evt, match) { // BS8521 acknowledge handler - for catalogue delivery
        debug.enabled && debug(this.session.sid, 'arcAcknowledge:', JSON.stringify(match));
        this.session.signal('communicator', 'arcAcknowledge', match, function arcAckCb(err, payload) {
            if (!payload)
                return;

            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcAcknowledgeCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/A0(?<unit>\\d\\d\\d\\d)#': function onArcSelect(evt, match) { // BS8521 unit select handler
        var ballast = 'A000000000000#', unit = match[1];
        debug.enabled && debug(this.session.sid, 'arcSelect:', unit, JSON.stringify(match));
        this.session.signal('communicator', 'arcSelect', unit, match, function arcSelectCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcSelectCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/A1(?<unit>\\d\\d\\d\\d)#': function onArcCatalogue(evt, match) { // BS8521 calalogue handler
        var ballast = 'A000000000000#', unit = match[1];
        debug.enabled && debug(this.session.sid, 'arcCatalogue:', unit, JSON.stringify(match));
        this.session.signal('communicator', 'arcCatalogue', unit, match, function arcCatalogueCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcCatalogueCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/A2(?<system>\\d\\d)(?<ctrl>\\d\\d)#': function onArcControl(evt, match) { // BS8521 control handler
        var ballast = 'A' + match[1] + '00#', control = ConsumerNowipVolt.control[match[1]];
        debug.enabled && debug(this.session.sid, 'arcControl:', control, JSON.stringify(match));
        this.session.signal('communicator', 'arcControl', control, match, function arcControlCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcControlCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/A3(?<speech>.)#': function onArcSpeech(evt, match) { // BS8521 speech-state handler
        var ballast = 'B', speech = ConsumerNowipVolt.speech[match[1]];
        debug.enabled && debug(this.session.sid, 'arcSpeech:', speech, JSON.stringify(match));
        this.session.signal('communicator', 'arcSpeech', speech, match, function arcSpeechCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcSpeechCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/A4(?<system>\\d\\d)(?<param>\\d\\d\\d)(?<value>.{20})(\\d\\d)#': function onArcParamSet(evt, match) { // BS8521 set parameter handler
        var ballast = 'A' + match[1] + '000#', param = ConsumerNowipVolt.param[match[2]], value = match[3];
        debug.enabled && debug(this.session.sid, 'arcParamSet:', param, value, JSON.stringify(match));
        this.session.signal('communicator', 'arcParamSet', param, value, match, function arcParamSetCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcParamSetCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/A5(?<system>\\d\\d)(?<param>\\d\\d\\d)#': function onArcParamGet(evt, match) { // BS8521 get parameter handler
        var ballast = 'A' + match[1] + '000#', param = ConsumerNowipVolt.param[match[2]];
        debug.enabled && debug(this.session.sid, 'arcParamGet:', param, JSON.stringify(match));
        this.session.signal('communicator', 'arcParamGet', param, match, function arcParamGetCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcParamGetCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
    '/AC(?<pin>\\d\\d\\d\\d)#': function onArcProgram(evt, match) { // BS8521 enter programming mode handler
        var ballast = 'A0000#', pin = match[1];
        debug.enabled && debug(this.session.sid, 'arcProgram:', pin, JSON.stringify(match));
        this.session.signal('communicator', 'arcProgram', pin, match, function arcProgramCb(err, payload) {
            var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: payload || ballast, $: { type: 'Response Data' } }] } });
            debug(this.session.sid, 'arcProgramCb:', xml);
            esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
        }.bind(this));
    },
});
