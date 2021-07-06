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
        pin: undefined, // programming mode pin
        sent: false, // tracks whether the nowip ATM message has been sent to the arc
        session: session, // a reference to the owning session
        uris: esl.parseUris(uris.replace(/ /g, '')),    // [ {scheme,user,password,host,port,params,headers}, ...]
        uuids: {}, // { uuid: boolean } collection of active outbound channel-ids
    });
}

Object.assign(ConsumerNowipVolt, {// _this_ of all methods is the StateMachine instance
    AX: /a([0-9A-D*#])/g, // regex to match speech commands - speak=[A]7, listen=[A]8, clear=[A]9, close=[A]D, null=[A]#,
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
        '001': 'arc1',
        '002': 'arc2',
        '003': 'arc3',
        '004': 'arc4',
        '005': 'person5',
        '006': 'person6',
        '007': 'person7',
        '008': 'person8',
        '009': 'sequence',
        '010': 'redials',
        '011': 'preDelay',
        '012': 'unitId1',
        '013': 'unitId2',
        '014': 'user1',
        '015': 'user2',
        '016': 'user3',
        '017': 'user4',
        '018': 'pin',
        '019': 'loudspeaker',
        '020': 'speech',
        '021': 'autoAnswer',
        '022': 'intruderDelay',
        '023': 'reassuranceTone',
        '024': 'dialMode',
        '025': 'time',
        '026': 'phoneWarning',
        '027': 'mainsWarning',
        '028': 'periodicDays',
        '029': 'awayMode',
        '030': 'systemType',
        '031': 'equipmentId',
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
        if (evt.type === 'CHANNEL_ANSWER')
            this.session.signal('answer');
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
        var err, cmdN;
        debug(this.session.sid, 'INFO:', evt.headers['Event-Sequence'], evt.body);
        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = Object.assign(err || js, { xml: evt.body });
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
        if (err)
            return console.log(this.session.sid, 'onConsumerNowipVoltInfo:', err) || this;

        cmdN = (evt.parsed.CDSTelecare || { Command: [] }).Command[0];
        isNaN(cmdN) || this.signal('cdsCommand' + cmdN, evt, first);
        return this;
    },
    cdsCommand0: function onCdsCommandMiscPayload(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandMiscPayload');
        var match, digits = (evt.parsed.CDSTelecare || { Digits: [] }).Digits[0];
        for (var cmd in ConsumerNowipVolt) {
            if (cmd[0] !== '/') // regex indicator
                continue;
            if (!ConsumerNowipVolt[cmd].re)
                ConsumerNowipVolt[cmd].re = new RegExp(cmd.slice(1));
            if (!(match = digits.match(ConsumerNowipVolt[cmd].re)))
                continue;
            this.signal(cmd, evt, match);
        }
    },
    cdsCommand1: function onCdsCommandClearChildCall(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandClearChildCall - UNIMPLEMENTED');
    },
    cdsCommand2: function onCdsCommandClearCall(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandClearCall');
        this.signal('cleanup');
    },
    cdsCommand3: function onCdsCommandSetDeviceSpeechStateListen(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandSetDeviceSpeechStateListen - UNIMPLEMENTED');
    },
    cdsCommand4: function onCdsCommandSetDeviceSpeechStateSpeak(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandSetDeviceSpeechStateSpeak - UNIMPLEMENTED');
    },
    cdsCommand5: function onCdsCommandSetDeviceSpeechModeSimplex(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandSetDeviceSpeechModeSimplex - UNIMPLEMENTED');
    },
    cdsCommand6: function onCdsCommandSetDeviceSpeechModeDuplex(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandSetDeviceSpeechModeDuplex - UNIMPLEMENTED');
    },
    cdsCommand7: function onCdsCommandClearAndConnectAlarmDeviceChildCall(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandClearAndConnectAlarmDeviceChildCall - UNIMPLEMENTED');
    },
    cdsCommand8: function onCdsCommandConnectAlarmDeviceToNewChildCall(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandConnectAlarmDeviceToNewChildCall - UNIMPLEMENTED');
    },
    cdsCommand10: function onCdsCommandUpdateAlarmDeviceDigits(evt, first) {
        debug(this.session.sid, 'INFO: CdsCommandUpdateAlarmDeviceDigits - UNIMPLEMENTED');
    },
    '/T250:80:AT80:80:(.)': function onCdsQuick(evt, match) {
        var response, quick = ConsumerNowipVolt.quick[match[1]];
        if (!evt.parsed.CDSTelecare.Response)
            return debug(this.session.sid, 'INFO: CdsQuick', quick);

        if ('9'.includes(match[1])) // send STATUS
            evt.parsed.CDSTelecare.Response[0] = response = 'A000000#';
        else if ('78D#'.includes(match[1])) // send ACK
            evt.parsed.CDSTelecare.Response[0] = response = 'B';
        if (!response)
            return debug(this.session.sid, 'INFO: CdsQuick', quick, '?' + match[1]);

        var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: response, $: { type: 'Response Data' } }] } });
        debug(this.session.sid, 'INFO: CdsQuick', quick, xml);
        esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
    },
    '/A2(\\d\\d)(\\d\\d)#': function onCdsControl(evt, match) {
        if (match[2] === '32')
            this.pin = undefined;
        var control = ConsumerNowipVolt.control[match[2]] || '?';
        var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: 'A' + match[1] + match[2] + '#', $: { type: 'Response Data' } }] } });
        debug(this.session.sid, 'INFO: CdsControl', control, xml);
        esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
    },
    '/A3(.)#': function onCdsSpeech(evt, match) {
        var speech = ConsumerNowipVolt.speech[match[1]];
        var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: 'B', $: { type: 'Response Data' } }] } });
        debug(this.session.sid, 'INFO: CdsSpeech', speech, xml);
        esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
    },
    '/A4(\\d\\d)(\\d\\d\\d)(.{20})(\\d\\d)#': function onCdsParamSet(evt, match) {
        var response = this.pin ? 'A' + match[1] + match[2] + '#' : 'A' + match[1] + '000#';
        var param = ConsumerNowipVolt.param[match[2]];
        var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: response, $: { type: 'Response Data' } }] } });
        debug(this.session.sid, 'INFO: CdsParamSet', param, match[3], xml);
        esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
    },
    '/A5(\\d\\d)(\\d\\d\\d)#': function onCdsParamGet(evt, match) {
        var response = 'A' + match[1] + '000#';
        var param = ConsumerNowipVolt.param[match[2]];
        var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: response, $: { type: 'Response Data' } }] } });
        debug(this.session.sid, 'INFO: CdsParamGet', param, xml);
        esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
    },
    '/AC(\\d\\d\\d\\d)#': function onCdsProgram(evt, match) {
        this.pin = match[1];
        var xml = js2xmlInfo.buildObject({ CDSTelecare: { Payload: [{ _: 'B', $: { type: 'Response Data' } }] } });
        debug(this.session.sid, 'INFO: CdsProgram', match[1], xml);
        esl.executeAsyncX('eval', ['${uuid_send_info(${uuid} application xml;charset=UTF-8 ' + xml + ')}'], this.uuid);
    },
});
