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

function transaction(type, match /* , ... */) { // _this_ is Communicator instance
    var Substate;
    //console.log('transaction: arguments =', JSON.stringify(arguments));
    switch (type) {
        //case 'acknowledge': // ('acknowledge', match) - response for 'catalogue', 'program', 'select'
        //    break; // handled by preceeding substate when important
        case 'catalogue': // ('catalogue', match, unit)
            match.send = 'a1' + ('0000' + (arguments[2] || 0)).slice(-4) + '#@80';
            match.regex = /#A(\d{12})#?/g;
            Substate = exports.Generic;
            break;

        case 'command': // ('command', match, command)
            // non-bs8521 commands
            break;

        case 'control': // ('control', match, control) - control is a string
            match.send = 'a200' + match[2] + '#@80';
            match.regex = /#A(\d{4})#?/g;
            Substate = exports.Generic;
            break;

        case 'paramGet': // ('paramGet', match, param) - param is a string
            match.send = 'a500' + match[2] + '#@80';
            match.regex = /#A(\d{27})#?/g;
            Substate = exports.Generic;
            break;

        case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
            match.send = 'a' + nowip.stringify({
                family: 4,
                conformance: 0,
                parameter: arguments[2],
                value: arguments[3],
            }, nowip.parse.paramset, true) + '#@80';
            match.regex = /#A(\d{5})#?/g;
            Substate = exports.Generic;
            break;

        case 'program': // ('program', match, pin) - ignores ACK - pin is numeric
            match.send = 'ac' + ('0000' + (arguments[2] || 0)).slice(-4) + '#@80';
            match.regex = /#A(\d{5})#?/g;
            Substate = exports.Generic;
            break;

        case 'quick': // ('quick', match, quick) - quick is a string
            match.send = 'a@250+' + match[1] + '@80';
            switch (arguments[2]) {
                case 'speak': // ack: B
                    break;
                case 'listen': // ack: B
                    break;
                case 'clear': // status: A000000#
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

        case 'select': // ('select', match, unit) - unit is numeric
            match.send = 'a0' + ('0000' + (arguments[2] || 0)).slice(-4) + '#@80';
            match.regex = /#A(\d{12})#?/g;
            Substate = exports.Generic;
            break;

        case 'speech': // ('speech', match, speech) - speech is a string
            match.send = 'a3' + match[1] + '#@80';
            Substate = exports.Generic;
            break;
    }
    return Substate;
}
