#! /usr/bin/env node-strict
var debug = require('debug')('communicator:detect:bs8521');
var nowip = require('../../nowip');
module.exports = exports = new (function Bs8521() {
    Object.assign(this, {
        Close: require('./Bs8521/Close'),           // state-machine to action channel-close
        Establish: require('./Bs8521/Establish'),   // state-machine to action the channel establish
        Generic: require('./Bs8521/Generic'),       // state-machine to action generic send-ack exchanges
        //Keepalive: require('./Bs8521/Null'),        // state-machine to action the keepalive control
        //Speech: require('./Bs8521/Speech'),         // state-machine to action simplex/duplex control
        debug: debug,                               // for reference by substates
        digitsMs: digitsMs,                         // help function to calculate digits send-duration
        dtmfMaxMs: 2500,                            // max valid DTMF duration
        //keepaliveMs: 60000,                         // time between keep-online messages - used by communicator-detect
        transaction: transaction,                   // helper function to prepare the necessary dispatch
    });
})();

function transaction(type, match /* ..., cb */) {
    switch (type) {
        //case 'acknowledge': // ('acknowledge', match) - response for 'catalogue', 'program', 'select'
        //    break; // handled by preceeding substate when important
        case 'catalogue': // ('catalogue', match, unit)
            break;

        case 'command': // ('command', match, command)
            // non-bs8521 commands
            break;

        case 'control': // ('control', match, control)
            match.send = 'a200' + match[2] + '#@80';
            return exports.Generic;
            break;

        case 'paramGet': // ('paramGet', match, param)
            match.send = 'a500' + match[2] + '#@80';
            return exports.Generic;

        case 'paramSet': // ('paramSet', match, param, value)
            match.send = 'a' + nowip.stringify({
                family: 4,
                conformance: 0,
                parameter: arguments[2],
                value: arguments[3],
            }, nowip.parse.paramset, true) + '#@80';
            return exports.Generic;

        case 'program': // ('program', match', pin) - ignores ACK
            match.send = 'ac' + match[1] + '#@80';
            return exports.Generic;

        case 'quick': // ('quick', match, quick)
            match.send = 'a@250+' + match[1] + '@80';
            return exports.Generic;

        case 'select': // ('select', match, unit)
            break;

        case 'speech': // ('speech', match, speech)
            match.send = 'a3' + match[1] + '#@80';
            return exports.Generic;
    }
}

function digitsMs(digits, pauseMs) { // calculate the transmission time for a f/s digit-string
    isNaN(pauseMs) && (pauseMs = 80);
    return digits.split(/\++/g).reduce(function (wksp, part, idx, arr) { // split on '+' giving array of [digits@durationMs, ...]
        var parts = part.split('@'); // sub-split on '@' giving [digits, durationMs]
        isNaN(parts[1]) && (parts[1] = 80); // default 80ms duration
        return wksp + parts[0].length * (pauseMs + +parts[1]); // collect part durations
    }, 0);
}
