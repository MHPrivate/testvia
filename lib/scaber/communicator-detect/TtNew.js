#! /usr/bin/env node-strict
var debug = require('debug')('communicator:detect:ttnew');

module.exports = exports = new (function TtNew() { // Catalogue/Clear/Select are co-dependent
    Object.assign(this, {
        Catalogue: require('./TtNew/Catalogue'),    // state-machine to action a catalogue
        Clear: require('./TtNew/Clear'),            // state-machine to action a channel clear
        Establish: require('./TtNew/Establish'),    // state-machine to action the channel establish
        Generic: require('./TtNew/Generic'),        // state-machine to action miscellaneous transactions
        Grouped: Grouped,                           // constructor for protocol specific grouped object
        Select: require('./TtNew/Select'),          // state-machine to action htu-select
        debug: debug,               // for reference by substates
        dtmfMaxMs: 2500,            // max valid DTMF duration
        nullTones: '*@500',         // keepalive tones
        parse: parse,               // validating parser function for TT92 data
        transaction: transaction,   // helper function to prepare the necessary dispatch
        unlockTones: '3@500',       // tones to achieve door-release
    });
})();

function Grouped() {
    if (this instanceof Grouped === false)
        throw new Error('Constructor TtNew:Grouped requires \'new\'');

    Object.assign(this, {
        alarms: {}, // ordered dictionary of received alarms - hopefully leading to fifo handling
        fdcSent: false, // Full Duplex Capable
        fetch: function (remove) {
            var parsed = this.alarms[Object.keys(this.alarms)[0]];
            remove && parsed && delete this.alarms[parsed.raw];
            return parsed;
        },
        forcePending: false, // updated by substates Clear and Catalogue
    });
    Object.defineProperties(this, {
        pending: {
            get: function () {
                return Object.keys(this.alarms).length || +this.forcePending;
            },
            enumerable: true, configurable: true,
        },
        unit: {
            get: function () {
                var alarm = Object.keys(this.alarms)[0];
                return +(this.alarms[alarm] || { unit: 'DDD' }).unit.replace(/D/g, '0');
            },
            enumerable: true, configurable: true,
        },
    });
}

function transaction(type, match /* , ... */) { // _this_ is Communicator instance
    var Substate;
    //console.log('transaction: arguments =', JSON.stringify(arguments));
    switch (type) {
        //case 'acknowledge': // ('acknowledge', match) - response for 'catalogue', 'program', 'select'
        //    break; // handled by preceeding substate when important
        case 'catalogue': // ('catalogue', match, unit) - A000000000000#
            Substate = exports.Catalogue; // coupled with Clear
            break;

        case 'command': // ('command', match, command)
            // non-bs8521 commands
            break;

        case 'control': // ('control', match, control) - control is a string
            switch (arguments[2]) {
                case 'release1':
                case 'release2':
                case 'releaseKeysafe':
                case 'releaseAll':
                    match.send = exports.unlockTones;
                    Substate = match.send ? exports.Generic : undefined;
                    break;
                case 'undefined':
                case 'relay1On':
                case 'relay1Off':
                case 'relay2On':
                case 'relay2Off':
                case 'switchLocal':
                case 'switchARC':
                case 'switchPerson':
                case 'inactivityOn':
                case 'inactivityOff':
                case 'intruderOn':
                case 'intruderOff':
                case 'coldOn':
                case 'coldOff':
                case 'tempOn':
                case 'tempOff':
                case '+1hr':
                case '-1hr':
                case 'resetStatus':
                case 'inactivity':
                case 'systest':
                case 'suspend':
                case 'resume':
                case 'exit':
            }
            break;

        case 'paramGet': // ('paramGet', match, param) - param is a string
            break;

        case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
            break;

        case 'program': // ('program', match, pin) - ignores ACK - pin is numeric
            break;

        case 'quick': // ('quick', match, quick) - quick is a string
            switch (arguments[2]) {
                case 'speak': // ack: B
                    if (!this.grouped || this.speech === 'simplex') {
                        match.send = 'c@500';
                        Substate = exports.Generic;
                    }
                    break;
                case 'listen': // ack: B
                    if (!this.grouped || this.speech === 'simplex') {
                        match.send = '*@500';
                        Substate = exports.Generic;
                    }
                    break;
                case 'clear': // status: A000000#
                    Substate = exports.Clear; // coupled with Catalogue
                    break;
                case 'close': // ack: B
                    // gloria releases 2257ms after send (2257 - 2080 = +177ms)
                    // sara releases 1518ms after send (1518 - 2080 = -462ms)
                    // advent releases 4921ms after send (4921 - 2080 = 2841ms)
                    match.send = '#@2000';
                    match.delayMs = 3000;
                    Substate = exports.Generic;
                    break;
                case 'null': // ack: B ????
                    match.send = exports.nullTones;
                    Substate = match.send ? exports.Generic : undefined;
                    break;
            }
            break;

        case 'select': // ('select', match, unit) - unit is numeric - A000000000000#
            this.speech = this.direction = undefined;
            Substate = exports.Select;
            break;

        case 'speech': // ('speech', match, speech) - speech is a string
            switch (arguments[2]) {
                case 'reset': // ack: B
                    break;
                case 'volume1': // ack: B
                    break;
                case 'volume2': // ack: B
                    break;
                case 'volume3': // ack: B
                    break;
                case 'volumeUp': // ack: B
                    match.send = '1*500';
                    Substate = exports.Generic;
                    break;
                case 'volumeDn': // ack: B
                    match.send = '2@500';
                    Substate = exports.Generic;
                    break;
                case 'speaker1': // ack: B
                    break;
                case 'speaker2': // ack: B
                    break;
                case 'duplex': // ack: B
                    // a Grouped session cannot be switched to Duplex while a Unit is selected
                    if (!this.grouped) { // always deliver to dispersed Communicators
                        match.send = '701@80';
                        match.retryMs = 500; // over&above the digit send time
                        match.regex = /701/;
                        Substate = exports.Generic;
                        this.speech = 'duplex';
                    } else if (!this.speech) { // fake delivery to grouped Communicators on first request
                        match.send = true;
                        match.regex = true;
                        Substate = exports.Generic;
                        this.speech = 'duplex';
                    } else { // fail delivery to grouped Communicators on subsequent requests
                        match.send = false;
                        match.regex = true
                        Substate = exports.Generic;
                    }
                    break;
                case 'simplex': // ack: B
                    if (!this.grouped) { // always deliver to dispersed Communicators
                        match.send = '702@80';
                        match.retryMs = 500; // over&above the digit send time
                        match.regex = /702/;
                        Substate = exports.Generic;
                    } else if (this.speech === 'legacy') { // fake delivery to grouped Communicators on first request
                        match.send = true;
                        match.regex = true;
                        Substate = exports.Generic;
                    } else { // send speak-listen to grouped Communicators
                        match.send = 'c@500'; // listen is explicitly sent by carenet
                        Substate = exports.Generic;
                    }
                    this.speech = 'simplex';
                    break;
            }
            break;
    }
    return Substate;
}

function parse(data, fields, self) {
    var match = data.match(fields.regex);
    if (!match)
        return null;
    self = Object.defineProperties(fields.filter(Boolean).reduce(function (wksp, field, idx, arr) {
        wksp[field] = match[1 + idx];
        return wksp;
    }, Object.assign(self || {}, { raw: match[0], $: {} })), { $: { enumerable: false } }); // raw: { enumerable: false }
    self.generic && Object.assign(self, { grouped: fields.grouped.includes(self.generic), hvs: !fields.simplex.includes(self.generic + self.type) });

    if (data.length - match[0].length === 2) { // have 2 checksum digits
        self.$.checksum = Array.from(('00' + (100 - Array.from(self.raw.toUpperCase()).reduce(function (checksum, digit, idx, arr) {
            return checksum + parse.checksum.indexOf(digit);
        }, 0) % 100)).slice(-2)).map(function (n, idx, arr) { return (+n + 1) % 10 }).join('');
        self.verified = self.$.checksum === data.slice(-2);
    }
    return self;
}

Object.assign(parse, {
    checksum: Array.from('B1234567890AC*D#'),
});
parse.alarm8 = Object.assign('callcode,unit,battery,location,padding'.split(','), {
    regex: /^([\dA-D*#])([\dA-D*#]{3})([\dA-D*#])([\dA-D*#]{2})(D)/,
});
parse.alarm22 = Object.assign('type,reserved,generic,callcode,identity,padding'.split(','), {
    grouped: Array.from('23'),
    simplex: '00,01,02,03,10,11,12,13,14,20,21'.split(','),
    regex: /^([\dA-D*#])([\dA-D*#])([\dA-D*#])([\dA-D*#])([\dA-D*#]{12})([\dA-D*#]{4})/,
});
parse.selco = Object.assign('speech,reserved,unit,tag'.split(','), { // select confirmation message
    regex: /^([D1])(D{3})([\dA-D*#]{3})(A)/,
});
parse.clear = Object.assign('reserved,reserved2,tag'.split(','), { // clear confirmation message
    regex: /^(D{4})(D{3})(B)/,
});
