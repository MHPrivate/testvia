#! /usr/bin/env node-strict
var argsMap = require('../../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    cluster = require('cluster'),
    debug = require('debug')('detect2'),
    esl = require('../../esl'),
    events = require('events'),
    limit = require('../../limit'),
    main = require.main.exports,
    modesl = require('modesl'),
    mysql = require('../../mysql'),
    os = require('os'),
    rpscb = require('../../rpscb'),
    worker = require('../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

module.exports = Detect2;

function Detect2(leg, outbound) { // outbound varies the initial regExs list
    if (this instanceof Detect2 === false)
        throw new Error('Constructor Detect2 requires \'new\'');

    Object.assign(this, {
        ackFn: undefined, // pending ack-action
        active: leg.session.context.d2 || 0, // bitmask-nibbles: BSIA|TTOld|TTNew|TT92|BS8521 (bits: 8=active,4=?,2=?,1=?)
        digits: [], // [-0-9a-f]
        lastDigit: new Date, // timestamp
        lastIndex: 0, // consumed offset
        leg: leg, // bound leg
        quiesentFn: undefined, // pending quiesent-action
        regExs: Detect2.patterns, // ordered-array of Re
        timeout: undefined, // handle
    });
    Object.defineProperties(this, {
        active: { writable: false },
        leg: { enumerable: false, writable: false },
    });
}

Detect2.prototype.cleanup = function detectCleanup() { // _this_ is d2
    this.timeout = worker.resetTimeout(this.timeout);
};

Detect2.prototype.digit = function detect2Digit(digit) { // _this_ is d2
    var now = new Date,
        retn = false;
    if (digit.length < 2) { // zero OR one DTMF digits
        this.timeout = worker.resetTimeout(this.timeout);
        this.digits += '-'.repeat(Math.min(5, Math.floor((now - this.lastDigit) / 200))) + digit;
        this.lastDigit = now;
    } else { // DETECT_TONE indicator
        // telecare-stmf:[0-9A-D*#]         16:[G-V] - maybe not these!
        // telecare-burst:[0-9]             10:[ghijklmnop] - maybe not these!
        // telecare-junk:[1850|1645|1000]   3:[qrst]
        // telecare-grouped:[1850|1400]     2:[uvwx]
        return; // TODO: implementation placeholder
    }

    return (this.regExs.some(function (re, idx, arr) { // _this_ is d2
        re.lastIndex = 0;
        var match = re.exec(this.digits.slice(this.lastIndex));
        if (!match)
            return false; // unmatched

        var retn = re.fn.call(this.leg, match); // undefined=no-match | false=passive-matched | true=active-matched
        if (typeof retn !== 'boolean')
            return false; // also unmatched

        this.lastIndex += re.lastIndex;
        return true; // matched
    }, this) && retn); // only return true if pattern-func returned true
};
Detect2.re = function detect2re(dict) {
    return Object.keys(dict).map(function (key, idx, arr) {
        switch (typeof dict[key]) {
            case 'function':
                return Object.assign(new RegExp(key, 'g'), { fn: dict[key] });
        }
    }).filter(Boolean);
}
Detect2.patterns = Detect2.re({ // _this_ is leg    *** DON'T USE BACKSLASH IN REGEXs ***
    '^$': function start(match) {
        debug(this.session.sid, 'start', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-B$': function bs_ack(match) { // spk+lsn+close+null+speech+progack
        if (this.session.payload.protocol !== 'BSI 8521:2009')
            return undefined; // no-match

        debug(this.session.sid, 'bs_ack', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A((?<system>[0])(?<speech>[0-9])(?<conformance>[0-9]{2})(?<controllerunit>[0-9]{12})(?<event>[0-9]{3})(?<location>[0-9]{2})(?<priority>[0-9])(?<status>[0-9]{2}))(?<chksm>[0-9]{2})$': function bs_dispersed(match) { // match before #
        debug(this.session.sid, 'bs_dispersed', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A((?<system>[123])(?<speech>[0-9])(?<conformance>[0-9]{2})(?<controller>[0-9]{8})(?<unit>[0-9]{4})(?<event>[0-9]{3})(?<location>[0-9]{2})(?<priority>[0-9])(?<status>[0-9]{2}))(?<chksm>[0-9]{2})$': function bs_grouped(match) { // match before #
        debug(this.session.sid, 'bs_grouped', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A((?<conformance>[0-9]{2})(?<param>[0-9]{3})(?<value>[0-9]{20}))(?<chksm>[0-9]{2})#': function bs_paramget(match) {
        debug(this.session.sid, 'bs_paramget', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A(?<unit>[0-9]{4})(?<event>[0-9]{3})(?<location>[0-9]{2})(?<priority>[0-9])(?<status>[0-9]{2})#$': function bs_unitinfo(match) { // selected+catalogue
        debug(this.session.sid, 'bs_unitinfo', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A0000(?<pending>[0-9]{2})#$': function bs_cleared(match) {
        debug(this.session.sid, 'bs_cleared', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A(?<conformance>[0-9]{2})(?<param>[0-9]{3})#': function bs_paramset(match) {
        debug(this.session.sid, 'bs_paramset', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A0000#$': function bs_prognak(match) { // prognak
        debug(this.session.sid, 'bs_prognak', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A(?<conformance>[0-9]{2})32#$': function bs_progexit(match) { // prog-exit+
        debug(this.session.sid, 'bs_progexit', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-A(?<conformance>[0-9]{2})(?<ccode>[0-9]{2})#$': function bs_controlled(match) { // prog-exit+
        debug(this.session.sid, 'bs_controlled', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },

    '-D#([0-9A-D*]{4}[0-9A*]{4}[0-9A*]{2}[0-9A-D*#]{3}[0-9A*]{3}[0-9A-D*#]{4})(?<chksm>[0-9]{2})$': function tt_dh20(match) {
        // id: (?<type>[0-9A-D]).(?<generic>[0-9A-D])(?<callcode>[0-9A-D])(?<identity>[0-9*]{12})(?<extra>[0-9D*#]{4})
        // get: ([*]{4}([0-9A*]{16})
        // dsp: (?<pin>[0-9*]{4})(?<duration>[0-9A*]{4})(?<grade>[0-9*]{2})(?<delay>[0-9A-F]{2})(?<rcode>[0-9*])(?<flag>[0-9])([0-9*]{2})([0-9*]{4}).
        // grp: (?<pin>[0-9*]{4})(?<duration>[0-9A*]{4})(?<grade>[0-9*]{2})(?<delay>[0-9A-F]{3})(?<unit>[0-9A*]{3})(?<flag>[0-9A-F])(?<serial>[0-9]{2})
        debug(this.session.sid, 'tt_dh20', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-(?<speech>[01D])[0-9A-D*#]{3}(?<unit>[0-9A-D*#]{3})A$': function tt_selected(match) {
        debug(this.session.sid, 'tt_selected', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-DDDD[0-9A-D*#]{3}B$': function tt_cleared(match) {
        debug(this.session.sid, 'tt_cleared', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-(?<callcode>[0-79A-D*#])(?<unit>[0-9A-D*#]{3})(?<battery>[0-9A-D*#])(?<location>[0-9D*#]{2})D$': function tt_alarm8(match) {
        debug(this.session.sid, 'tt_alarm8', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched
    },
    '-8(?<reply>[0-9A-D*#]{6})D$': function tt_sfreply(match) {
        debug(this.session.sid, 'tt_sfreply', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return false; // passive-matched;
    },
    '.$': function trace(match) {
        Detect2.trace && debug(this.session.sid, 'trace', UTIL.stringify(match), this.d2.digits.slice(this.d2.lastIndex));
        return undefined; // no-match
    },
});
