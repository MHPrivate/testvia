#! /usr/bin/env node-strict
var debug = require('debug')('communicator:detect:bs8521'),
    nowip = require('../../nowip');

module.exports = exports = new (function Bs8521() {
    Object.assign(this, {
        Establish: require('./Bs8521/Establish'),   // state-machine to action the channel establish
        Generic: require('./Bs8521/Generic'),       // state-machine to action generic send-ack exchanges
        debug: debug,                               // for reference by substates
        dtmfMaxMs: 2500,                            // max valid DTMF duration
        hack: false,                                // whether to run programming-pin discovery
        nullTones: true,
        transaction: transaction,                   // helper function to prepare the necessary dispatch
    });
})();

var controlMap = {
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
    'none': '000',
    'arc1': '001',
    'arc2': '002',
    'arc3': '003',
    'arc4': '004',
    'person5': '005',
    'person6': '006',
    'person7': '007',
    'person8': '008',
    'sequence': '009',
    'redials': '010',
    'preDelay': '011',
    'unitId1': '012',
    'unitId2': '013',
    'user1': '014',
    'user2': '015',
    'user3': '016',
    'user4': '017',
    'pin': '018',
    'loudspeaker': '019',
    'speech': '020',
    'autoAnswer': '021',
    'intruderDelay': '022',
    'reassuranceTone': '023',
    'dialMode': '024',
    'datetime': '025',
    'phoneWarning': '026',
    'mainsWarning': '027',
    'periodicDays': '028',
    'awayMode': '029',
    'systemType': '030',
    'equipmentId': '031',
};
var quickMap = {
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

function transaction(type, match /* , ... */) { // _this_ is Communicator instance
    var Substate;
    //console.log('transaction: arguments =', JSON.stringify(arguments));
    switch (type) { // match is an array
        //case 'acknowledge': // ('acknowledge', match) - response for 'catalogue', 'program', 'select'
        //    break; // handled by preceeding substate when important
        case 'catalogue': // ('catalogue', match, unit) - unit is a numeric-string
            match.send = 'a1' + ('0000' + (arguments[2] || 0)).slice(-4) + '#@80';
            match.regex = /#A(\d{12})#?/g;
            Substate = exports.Generic;
            break;

        case 'command': // ('command', match, command) - command is a string
            // non-bs8521 commands
            break;

        case 'control': // ('control', match, control) - control is a string
            match.send = 'a200' + controlMap[arguments[2]] + '#@80';
            match.regex = /#A(\d{4})#?/g;
            Substate = exports.Generic;
            break;

        case 'paramGet': // ('paramGet', match, param) - param is a string
            match.send = 'a500' + paramMap[arguments[2]] + '#@80';
            match.regex = /#A(\d{27})#?/g;
            Substate = exports.Generic;
            break;

        case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
            match.send = 'a' + nowip.stringify({
                family: 4,
                conformance: 0,
                parameter: paramMap[arguments[2]],
                value: arguments[3],
            }, nowip.parse.paramset, true) + '#@80';
            match.regex = /#A(\d{5})#?/g;
            Substate = exports.Generic;
            break;

        case 'program': // ('program', match, pin) - ignores ACK - pin is a numeric-string
            match.send = 'ac' + ('0000' + (arguments[2] || 0)).slice(-4) + '#@80';
            match.regex = /#A(\d{5})#?/g;
            Substate = exports.Generic;
            break;

        case 'quick': // ('quick', match, quick) - quick is a string
            match.send = 'a@250+' + quickMap[arguments[2]] + '@80';
            switch (arguments[2]) {
                case 'speak': // ack: B
                    break;
                case 'listen': // ack: B
                    break;
                case 'clear': // status: A000000#
                    if (!this.selected)
                        match.send = '';
                    match.regex = /#A(\d{6})#?/g;
                    break;
                case 'close': // ack: B
                    break;
                case 'null': // ack: B ????
                    if (!exports.nullTones)
                        match.send = '';
                    break
            }
            Substate = match.send ? exports.Generic : undefined;
            break;

        case 'select': // ('select', match, unit) - unit is a numeric-string
            match.send = 'a0' + ('0000' + (arguments[2] || 0)).slice(-4) + '#@80';
            match.regex = /#A(\d{12})#?/g;
            if (!this.selected)
                Substate = exports.Generic;
            break;

        case 'speech': // ('speech', match, speech) - speech is a string
            match.send = 'a3' + speechMap[arguments[2]] + '#@80';
            Substate = exports.Generic;
            break;
    }
    return Substate;
}
