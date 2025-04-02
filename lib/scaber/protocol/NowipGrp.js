#! /usr/bin/env node-strict
var debug = require('debug')('protocol:nowipgrp'),
    nowip = require('../../nowip');

module.exports = exports = new (function Nowip() {
    Object.assign(this, {
        Generic: require('./NowipGrp/Generic'),        // state-machine to action generic send-ack exchanges
        Stabilise: require('./NowipGrp/Stabilise'),    // state-machine to help in establishing an outgoing grouped call
        transaction: transaction,                   // helper function to prepare the necessary dispatch
        debug: debug,                               // for reference by substates
    });
})();

const controlMap = {
    'release1': '01',
    'release2': '02',
    'releaseKeysafe': '03',
    'releaseAll': '04',
    'undefined': '05',
    'relay1On': '06',
    'relay1Off': '07',
    'relay2On': '08',
    'relay2Off': '09',
    'switchLocal': '10',
    'switchARC': '11',
    'switchPerson': '12',
    'inactivityOn': '13',
    'inactivityOff': '14',
    'intruderOn': '15',
    'intruderOff': '16',
    'coldOn': '17',
    'coldOff': '18',
    'tempOn': '19',
    'tempOff': '20',
    '+1hr': '21',
    '-1hr': '22',
    'resetStatus': '23',
    'inactivity': '24',
    'systest': '25',
    'suspend': '30',
    'resume': '31',
    'exit': '32',
};
var paramMap = {
    'none': '000', // Not available
    'arc1': '001', // Telephone number 1 (ARC)
    'arc2': '002', // Telephone number 2 (ARC)
    'arc3': '003', // Telephone number 3 (ARC)
    'arc4': '004', // Telephone number 4 (ARC)
    'person5': '005', // Telephne number 5 (personal recipient)
    'person6': '006', // Telephne number 6 (personal recipient)
    'person7': '007', // Telephne number 7 (personal recipient)
    'person8': '008', // Telephne number 8 (personal recipient)
    'sequence': '009', // Telephone dial sequence [nnnnnnnn] 1..8
    'redials': '010', // Redial attempts
    'preDelay': '011', // Pre-alarm condition [nn] 00..99
    'unitId1': '012', // Unit/scheme ID no. 1
    'unitId2': '013', // Unit/scheme ID no. 2
    'fast1': '014', // User fast dial telephone number 1
    'fast2': '015', // User fast dial telephone number 2
    'fast3': '016', // User fast dial telephone number 3
    'fast4': '017', // User fast dial telephone number 4
    'pin': '018', // Programming mode security code [nnnn]
    'loudspeaker': '019', // Loudspeaker [nn] 00=off/01=on
    'speech': '020', // Default speech type setting [nn] 00=duplex/01=simplex
    'autoAnswer': '021', // Auto answer setting [nn] 00=off/01=on
    'intruderDelay': '022', // Intruder alarm entry/exit delay [nn] 00..99 seconds
    'reassuranceTone': '023', // Reassurance tone [nn] 00=off/01=on
    'dialMode': '024', // Dial mode [nn] 00=dtmf/01=loop-disconnect
    'datetime': '025', // Set real time clock [YYYYMMDDhhmm]
    'phoneWarning': '026', // Telephone line disconnect warning [nn] 00=off/01=on
    'mainsWarning': '027', // Mains power fail warning [nn] 00=off/01=on
    'periodicDays': '028', // Periodic test call [00] 00..99 days
    'awayMode': '029', // Away mode [nn] 00=off/01=on
    'systemType': '030', // System type [nn] see BS8521
    'equipmentId': '031', // Equipment-specific identifier
};
const quickMap = {
    'speak': '7',
    'listen': '8',
    'clear': '9',
    'close': 'D',
    'null': '#',
};
var speechMap = {
    'reset': '0',
    'volume1': '1',
    'volume2': '2',
    'volume3': '3',
    'volumeUp': '4',
    'volumeDn': '5',
    'speaker1': '6',
    'speaker2': '7',
    'duplex': '8',
    'simplex': '9',
};

function transaction(type, match /* , ... */) { // _this_ is Leg instance
    var Substate;
    switch (type) {
        case 'catalogue': // ('catalogue', match, unit) - unit is a numeric-string
            match.type = '2';
            match.send = '1' + ('0000' + (arguments[2] || 0)).slice(-4);
            match.regex = /(?<unit>\d{4})(?<event>\d{3})(?<location>\d{2})(?<priority>\d)(?<status>\d{2})/;
            Substate = exports.Generic;
            break;

        case 'select':
            match.type = '2';
            match.send = '0' + ('0000' + (arguments[2] || 0)).slice(-4); // e.g., 00001
            match.regex = /(?<unit>\d{4})(?<event>\d{3})(?<location>\d{2})(?<priority>\d)(?<status>\d{2})/;
            Substate = exports.Generic;
            break;

        case 'control':
            match.type = '2';
            match.send = '200' + controlMap[arguments[2]];
            match.regex = /(?<system>\d{2})(?<controlcode>\d{2})/;
            Substate = exports.Generic;
            break;

        case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
            match.type = '8';
            match.send = nowip.stringify({
                family: 4,
                conformance: 0,
                parameter: paramMap[arguments[2]],
                value: arguments[3],
            }, nowip.parse.paramset, true);
            match.regex = /(?<system>\d{2})(?<parameter>\d{3})/;
            Substate = exports.Generic;
            break;

        case 'program': // ('program', match, pin) - ignores ACK - pin is a numeric-string
            match.type = '2';
            match.send = 'C' + ('0000' + (arguments[2] || 0)).slice(-4);
            //match.regex = /(\d{5})/g;
            Substate = exports.Generic;
            break;

        case 'quick':
            match.type = '2';
            match.send = quickMap[arguments[2]];

            switch (arguments[2]) {
                case 'speak': // ack: A
                    break;
                case 'listen': // ack: A
                    break;
                case 'clear': // outstanding: 00
                    if (this.grouped && this.selected) // only permit clear for grouped callers that are currently selected
                        this.selected = null;
                    else
                        match.send = '';
                    match.regex = /(?<outstanding>\d{2})/;
                    break;
                case 'close': // ack: A
                    break;
                case 'null': //
                    if (!exports.nullTones)
                        match.send = '';
                    break
            }

            Substate = exports.Generic;
            break;

        case 'speech': // ('speech', match, speech) - speech is a string
            match.type = '2';
            match.send = '3' + speechMap[arguments[2]];
            Substate = exports.Generic;
            break;
    }
    debug(this.session.sid, `transaction: ${type}, send: ${match.send}, expect: ${match.regex}, substate: ${Substate.name}`);
    return Substate;
}