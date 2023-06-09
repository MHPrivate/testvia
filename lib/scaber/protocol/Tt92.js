#! /usr/bin/env node-strict
var debug = require('debug')('protocol:tt92');

module.exports = exports = new (function Tt92() {
    Object.assign(this, {
        Catalogue: require('./Tt92/Catalogue'),     // state-machine to action a catalogue
        Clear: require('./Tt92/Clear'),             // state-machine to action a channel clear
        Establish: require('./Tt92/Establish'),     // state-machine to action the channel establish
        Generic: require('./Tt92/Generic'),         // state-machine to action miscellaneous transactions
        Grouped: Grouped,                           // constructor for protocol specific grouped object
        Select: require('./Tt92/Select'),           // state-machine to action htu-select
        Stabilise: require('./Tt92/Stabilise'),     // state-machine to outgoing establish a grouped call
        backfill: backfill,                         // helper to backfill missing stmf digits
        chksm: chksm,                               // checksum calculator function for TT92 data
        debug: debug,                               // for reference by substates
        dtmfMaxMs: 2500,                            // max valid DTMF duration
        listenDtmf: '*@500',                        // dtmf also used for keepalive
        parse: parse,                               // validating parser function for TT92 data
        speakDtmf: 'c@500',                         // dtmf also used for keepalive
        transaction: transaction,                   // helper function to prepare the necessary dispatch
        unlockDtmf: '3@500',                        // dtmf to achieve door-release
        arcDtmf: { // permitted agent tone generation
            '1': '1@400', '2': '2@400', '3': '3@400', 'A': null,
            '4': '4@400', '5': '5@400', '6': '6@400', 'B': null,
            '7': '7@400', '8': '8@400', '9': '9@400', 'C': null,
            '*': '*@400', '0': null,    '#': null,    'D': null,
        },
    });
})();

function Grouped() {
    if (this instanceof Grouped === false)
        throw new Error('Constructor Tt92:Grouped requires \'new\'');

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

function transaction(type, match, arg2, arg3, arg4 /* , ... */) { // _this_ is Leg instance
    var Substate;
    //console.log('transaction: arguments =', UTIL.stringify(arguments));
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
            switch (arg2) {
                case 'release1':
                case 'release2':
                case 'releaseKeysafe':
                case 'releaseAll':
                    match.send = exports.unlockDtmf;
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
                    break;
                case 'exit':
                    this.speech = 'duplex';
                    match.send = ['*c@500', 'd*@80', '701@80'].join('+w'); // listen/speak wait/prog-done wait/duplex
                    Substate = exports.Generic;
                    match.regex = /701/;
                    match.delayMs = 1400; // extended inter-digit delay in case we receive a spurious 'D'
                    match.retryMs = 500; // additional delay awaiting regex DTMF
            }
            break;

        case 'paramGet': // ('paramGet', match, param) - param is a string
            switch (arg2) {
                case 'arc1': // Telephone number 1 (ARC)
                    wksp = { param: '000' };
                    break;
                case 'arc2': // Telephone number 2 (ARC)
                    wksp = { param: '001' };
                    break;
                case 'unitId1':
                    wksp = { param: '002' };
                    break;
                case 'ttcode': // User option tree code
                    wksp = { param: '011' };
                    break;
                case 'generic':
                    wksp = { param: ('000' + +arg3).slice(-3) };
                    break;
            }
            if (wksp) {
                wksp.value = 'A'.repeat(16);
                match.send = 'D#1' + wksp.param + wksp.value + chksm('0' + wksp.param + wksp.value) + '@80';
                match.retryMs = 500; // extra delay over&above digits-duration
                match.regex = /D#[\d*#A]{20}\d{2}/;
                Substate = exports.Generic;
            }
            break;

        case 'paramSet': // ('paramSet', match, param, value) - param is a string, value is a digit-string
            switch (arg2) {
                case 'arc1': // Telephone number 1 (ARC)
                    wksp = { param: '000', value: arg3 || '' };
                    break;
                case 'arc2': // Telephone number 2 (ARC)
                    wksp = { param: '001', value: arg3 || '' };
                    break;
                case 'unitId1':
                    wksp = { param: '002', value: arg3 || '' };
                    break;
                case 'ttcode': // User option tree code
                    wksp = { param: '011', value: arg3 || '' };
                    break;
                case 'generic':
                    wksp = { param: ('000' + +arg3).slice(-3), value: arg4 || '' };
                    break;
            }
            if (wksp) {
                wksp.value = (wksp.value + 'A'.repeat(16)).slice(0, 16);
                match.send = 'D#0' + wksp.param + wksp.value + chksm('0' + wksp.param + wksp.value) + '@80';
                match.retryMs = 500; // extra delay over&above digits-duration
                match.regex = /DB/;
                Substate = exports.Generic;
            }
            break;

        case 'program': // ('program', match, pin) - ignores ACK - pin is numeric
            if (!this.grouped) { // dispersed only
                match.send = 'c*wc*wc@500'; // speak/listen wait speak/listen wait speak
                Substate = match.send ? exports.Generic : undefined;
            }
            break;

        case 'quick': // ('quick', match, quick) - quick is a string
            switch (arg2) {
                case 'speak': // ack: B
                    if (this.speech === 'legacy')
                        this.speech = 'simplex';
                    if (!this.grouped || this.speech === 'simplex') {
                        match.send = exports.speakDtmf;
                        Substate = exports.Generic;
                        this.direction = 'speak';
                    }
                    break;
                case 'listen': // ack: B
                    if (this.speech === 'legacy')
                        this.speech = 'simplex';
                    if (!this.grouped || this.speech === 'simplex') {
                        match.send = exports.listenDtmf;
                        Substate = exports.Generic;
                        this.direction = 'listen';
                    }
                    break;
                case 'clear': // status: A000000#
                    if (this.grouped && this.selected) // only permit clear for grouped callers that are currently selected
                        Substate = (this.selected = null) || exports.Clear; // coupled with Catalogue
                    break;
                case 'close': // ack: B
                    // gloria releases 2257ms after send (2257 - 2080 = +177ms)
                    // sara releases 1518ms after send (1518 - 2080 = -462ms)
                    // advent releases 4921ms after send (4921 - 2080 = 2841ms)
                    match.send = '*@500+#@2000';
                    match.delayMs = 6000;
                    Substate = exports.Generic;
                    break;
                case 'null': // ack: B ????
                    match.send = (this.direction === 'speak') ? exports.speakDtmf : exports.listenDtmf;
                    Substate = match.send ? exports.Generic : undefined;
                    break;
            }
            break;

        case 'select': // ('select', match, unit) - unit is numeric - A000000000000#
            if (this.grouped && !this.selected) // only permit select for grouped callers that are currently not selected
                Substate = (this.speech = this.direction = undefined) || exports.Select;
            break;

        case 'speech': // ('speech', match, speech) - speech is a string
            switch (arg2) {
                case 'reset': // ack: B
                    break;
                case 'volume1': // ack: B
                    break;
                case 'volume2': // ack: B
                    break;
                case 'volume3': // ack: B
                    break;
                case 'volumeUp': // ack: B
                    match.send = '1@500';
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
                    if (!this.grouped) { // always deliver to dispersed Legs
                        match.send = '701@80';
                        match.retryMs = 1100; // over&above the digits send time
                        match.regex = /701/;
                        Substate = exports.Generic;
                        this.speech = 'duplex';
                    } else if (!this.speech) { // fake delivery to grouped Legs on first request
                        match.send = true;
                        match.regex = true;
                        Substate = exports.Generic;
                        this.speech = 'duplex';
                    } else { // fail delivery to grouped Legs on subsequent requests
                        match.send = false;
                        match.regex = true
                        Substate = exports.Generic;
                    }
                    break;
                case 'simplex': // ack: B
                    if (!this.grouped) { // always deliver to dispersed Legs
                        match.send = '702@80';
                        match.retryMs = 1100; // over&above the digits send time
                        match.regex = /702/;
                        Substate = exports.Generic;
                    } else if (this.speech === 'legacy') { // fake delivery to grouped Legs on first request
                        match.send = true;
                        match.regex = true;
                        Substate = exports.Generic;
                    } else { // send speak-listen to grouped Legs
                        match.send = exports.speakDtmf; // just speak, listen is explicitly sent by carenet
                        Substate = exports.Generic;
                        this.direction = 'speak';
                    }
                    this.speech = 'simplex';
                    break;
            }
            break;

        case 'dtmf':
            match.send = !this.session.context.passDtmf && exports.arcDtmf[arg2];
            Substate = match.send && exports.Generic;
            break;
    }
    return Substate;
}

function backfill(data, n) {
    return (data && n) ? data[data.length - 1].repeat(n) : '';
}

function chksm(raw) {
    var a,
        b = parse.checksum1[Array.from(raw.toUpperCase()).reduce(function (wksp, digit, idx, arr) {
            var x = (wksp ^ (a[idx] = parse.checksum0.indexOf(digit))) & 0xFF;
            return (((x | x << 8) >> 3) + 1) & 0xFF;
        }.bind(a = Array(raw.length)), 0) & 0xF] + parse.checksum2[0];

    return Array.from(('00' + (100 - (a.reduce(function (wksp, val, idx, arr) {
        return wksp + parse.checksum3[(val + b) & 0xF];
    }, 0) % 100))).slice(-2)).map(function (n, idx, arr) { return (+n + 1) % 10 }).join(''); // #3
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

    if (data.length - match[0].length !== 2) // don't have 2 checksum digits
        return self;

    if (!self.verified) { // attempt Tt92 checksum
        var a,
            b = parse.checksum1[Array.from(self.raw).reduce(function (wksp, digit, idx, arr) {
                var x = (wksp ^ (a[idx] = parse.checksum0.indexOf(digit))) & 0xFF;
                return (((x | x << 8) >> 3) + 1) & 0xFF;
            }.bind(a = Array(self.raw.length)), 0) & 0xF] + parse.checksum2[0];

        self.$.checksum = Array.from(('00' + (100 - (a.reduce(function (wksp, val, idx, arr) {
            return wksp + parse.checksum3[(val + b) & 0xF];
        }, 0) % 100))).slice(-2)).map(function (n, idx, arr) { return (+n + 1) % 10 }).join(''); // #3
        self.verified = self.$.checksum === data.slice(-2) && 'Tt92';
    }

    if (!self.verified) { // attempt TtNew checksum
        self.$.checksum = Array.from(('00' + (100 - Array.from(self.raw.toUpperCase()).reduce(function (checksum, digit, idx, arr) {
            return checksum + parse.checksum.indexOf(digit);
        }, 0) % 100)).slice(-2)).map(function (n, idx, arr) { return (+n + 1) % 10 }).join('');
        self.verified = self.$.checksum === data.slice(-2) && 'TtNew';
    }

    return self;
}
Object.assign(parse, {
    checksum: Array.from('B1234567890AC*D#'), // TtNew map
    checksum0: Array.from('0123456789ABCD*#'), // Tt92 map0
    checksum1: [12, 4, 10, 13, 0, 6, 8, 15, 7, 11, 2, 5, 14, 1, 9, 3], // Tt92 map1
    checksum2: [4, 12, 8, 14, 6, 13, 2, 9, 15, 3, 11, 7, 1, 5, 0, 10], // Tt92 map2
    checksum3: [9, 1, 14, 7, 13, 10, 3, 6, 15, 4, 8, 11, 12, 5, 0, 2], // Tt92 map3
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
