#!/usr/bin/env node-strict
var nowip = module.exports;

// nowip format: CDTTGGGGGGGGRRRREEELLPSS

nowip.system = Object.assign([ // C
    'Local unit and controller',
    'Grouped equipment with supervisor off duty',
    'Grouped equipment with supervisor on duty',
    'Grouped equipmemt with supervisor on duty acting as an ARC',
    'ARC',
], { default: 0, format: '0', other: 'Reserved to BSI' });

nowip.speech = Object.assign([ // D
    'Non-Speech',
    'VOX',
    'Controlled switched speech',
], { default: 1, format: '0', other: 'Reserved to BSI' });

nowip.conformance = Object.assign([ // TT
    'conforming',
], { default: 0, format: '00', other: 'Reserved to BSI' });

nowip.controller = Object.assign([ // 'GGGGGGGG'
], { default: 0, format: '00000000', other: undefined });

nowip.unit = Object.assign([ // 'RRRR'
], { default: 0, format: '0000', other: undefined });

nowip.controllerunit = Object.assign([ // 'GGGGGGGGRRRR'
], { default: 0, format: '000000000000', other: undefined });

nowip.event = Object.assign([ // EEE
    'No alarm event/reason information/cancelled',
    'Undefined/unallocated(1)',
    'Undefined/unallocated(2)',
    'Undefined/unallocated(3)',
    'Undefined/unallocated(4)',
    'Undefined/unallocated(5)',
    'Undefined/unallocated(6)',
    'Undefined/unallocated(7)',
    'Undefined/unallocated(8)',
    'Undefined/unallocated(9)',
    'Fixed trigger 1', // 010
    'Fixed trigger 2',
    'Pressure mat',
    'Door contact',
    'Passive infra-red (PIR) detector',
    'Boundary breach',
    'Smoke',
    'Fire',
    'Bogus caller trigger',
    'Personal trigger 1',
    'Personal trigger 2', // 020
    'Fall trigger 1',
    'Fall trigger 2',
    'Personal attack 1',
    'Personal attack 2',
    'Panic button',
    'Carbon monoxide gas',
    'Natural gas',
    'Intruder',
    'Automatic person down',
    'Property exit 1', // 030
    'Property exit 2',
    'High temperature',
    'Low temperature',
    'Temperature rate of rise',
    'Medication dispenser',
    'Enuresis',
    'Bed occupancy',
    'Chair occupancy',
    'Property occupancy 1',
    'Property occupancy 2', // 040
    'Bathroom occupancy',
    'Seizure',
    'Inactivity',
    'Environmental monitor',
    'Bed monitor',
    'Chair monitor',
    'Flood',
    'Bath level',
    'Lighting circuit',
    'Heating', // 050
    'Mains power',
    'System power supply',
    'Battery',
    'Duty switch',
    'Door open',
    'Fire door open',
    'System status',
    'Automatic periodic test call',
    'Telephone unit 1',
    'Telephone unit 2', // 060
    'Radio receiver',
    'IP communication link',
    'Serial data link',
    'System under test',
    'Undefined/unallocated(65)',
    'Undefined/unallocated(66)',
    'Undefined/unallocated(67)',
    'Undefined/unallocated(68)',
    'Undefined/unallocated(69)',
    'Undefined/unallocated(70)', // 070
    'Undefined/unallocated(71)',
    'Undefined/unallocated(72)',
    'Undefined/unallocated(73)',
    'Undefined/unallocated(74)',
    'Undefined/unallocated(75)',
    'Undefined/unallocated(76)',
    'Undefined/unallocated(77)',
    'Undefined/unallocated(78)',
    'Undefined/unallocated(79)',
    'Undefined/unallocated(80)', // 080
    'Undefined/unallocated(81)',
    'Undefined/unallocated(82)',
    'Undefined/unallocated(83)',
    'Undefined/unallocated(84)',
    'Undefined/unallocated(85)',
    'Undefined/unallocated(86)',
    'Undefined/unallocated(87)',
    'Undefined/unallocated(88)',
    'Undefined/unallocated(89)',
    'Service provider IDs', // 090
    'Service call',
    'Undefined/unallocated(92)',
    'Undefined/unallocated(93)',
    'Undefined/unallocated(94)',
    'Undefined/unallocated(95)',
    'Undefined/unallocated(96)',
    'Acknowledgement message',
    'Presence marking',
    'Service completed',
], { default: 0, format: '000', other: 'Reserved to BSI' });

nowip.location = Object.assign([ // LL
    'No location information', // 00 (00)
    'Local unit',              // 01 (01)
    'Hallway (downstairs)',    // 02 (02)
    'Hallway (upstairs)',      // 03 (03)
    'Stairs (main)',           // 04 (04)
    'Stairs (other)',          // 05 (05)
    'Landing',                 // 06 (06)
    'Bedroom 1 (master)',      // 07 (07)
    'Bedroom 2',               // 08 (08)
    'Bedroom 3 (other)',       // 09 (09)
    'Bedroom 4 (guest)',       // 10 (01)
    'Living room (main)',      // 11 (01)
    'Living room (second)',    // 12 (01)
    'Living area (other)',     // 13 (01)
    'Dining room (main)',      // 14 (01)
    'Dining room (second)',    // 15 (01)
    'Dining area (other)',     // 16 (01)
    'Bathroom (main)',         // 17 (01)
    'Bathroom (second)',       // 18 (01)
    'WC/toilet (upstairs)',    // 19 (01)
    'WC/toilet (downstairs)',  // 20 (02)
    'WC/toilet (other)',       // 21 (02)
    'Kitchen (main)',          // 22 (02)
    'Kitchen (second)',        // 23 (02)
    'Kitchen area (other)',    // 24 (02)
    'Utility room (main)',     // 25 (02)
    'Utility room (other)',    // 26 (02)
    'Entrance lobby',          // 27 (02)
    'Front door (main)',       // 28 (02)
    'Front door (other)',      // 29 (02)
    'Back door (main)',        // 30 (03)
    'Back door (other)',       // 31 (03)
    'Garage (main)',           // 32 (03)
    'Garage (other)',          // 33 (03)
    'Workshop',                // 34 (03)
    'Laundry (main)',          // 35 (03)
    'Laundry (other)',         // 36 (03)
    'Office (main)',           // 37 (03)
    'Study/office (other)',    // 38 (03)
    'Games room',              // 39 ()
    'Common room (main)',      // 40 ()
    'Common room (other)',     // 41 ()
    'Lift (main)',             // 42 ()
    'Lift (second)',           // 43 ()
    'Lift (other)',            // 44 ()
    'Front gate',              // 45 ()
    'Rear gate',               // 46 ()
    'Outbuilding (main)',      // 47 ()
    'Shed',                    // 48 ()
    'Outbuilding/shed (other)',// 49 ()
    'Garden (front)',          // 50 ()
    'Garden (rear)',           // 51 ()
    'Garden (other)',          // 52 ()
    'Basement/cellar',         // 53 ()
    'Ground floor',            // 54 ()
    'Bin store',               // 55 ()
    'Boiler room',             // 56 ()
    'Attic',                   // 57 ()
    'Reserved to BSI(58)',
    'Reserved to BSI(59)',
    'Reserved to BSI(60)', // 60
    'Reserved to BSI(61)',
    'Reserved to BSI(62)',
    'Reserved to BSI(63)',
    'Reserved to BSI(64)',
    'Reserved to BSI(65)',
    'Reserved to BSI(66)',
    'Reserved to BSI(67)',
    'Reserved to BSI(68)',
    'Reserved to BSI(69)',
    'Reserved to BSI(70)', // 70
    'Reserved to BSI(71)',
    'Reserved to BSI(72)',
    'Reserved to BSI(73)',
    'Reserved to BSI(74)',
    'Reserved to BSI(75)',
    'Reserved to BSI(76)',
    'Reserved to BSI(77)',
    'Reserved to BSI(78)',
    'Reserved to BSI(79)',
    'Proprietry(80)', // 80
    'Proprietry(81)',
    'Proprietry(82)',
    'Proprietry(83)',
    'Proprietry(84)',
    'Proprietry(85)',
    'Proprietry(86)',
    'Proprietry(87)',
    'Proprietry(88)',
    'Proprietry(89)',
    'Proprietry(90)', // 90
    'Proprietry(91)',
    'Proprietry(92)',
    'Proprietry(93)',
    'Proprietry(94)',
    'Proprietry(95)',
    'Proprietry(96)',
    'Proprietry(97)',
    'Proprietry(98)',
    'Proprietry(99)',
], { default: 0, format: '00', other: 'Reserved to BSI' });

nowip.priority = Object.assign([ // P (0=low -> 9=high)
], { default: 0, format: '0', other: undefined });

nowip.status = Object.assign([ // SS
    'Normal default', // 00
    'Privacy switch operated',
    'Non-speech manually operated',
    'Non-speech automatically operated',
    'In service (fault rectified)',
    'Fault status (alarm active)',
    'Fault status (alarm not active)',
    'Low battery status set',
    'Busy',
    'Out of service',
    'Reserved to BSI(10)', // 10
    'Reserved to BSI(11)',
    'Reserved to BSI(12)',
    'Reserved to BSI(13)',
    'Reserved to BSI(14)',
    'Reserved to BSI(15)',
    'Reserved to BSI(16)',
    'Reserved to BSI(17)',
    'Reserved to BSI(18)',
    'Reserved to BSI(19)',
    'Reserved to BSI(20)', // 20
    'Reserved to BSI(21)',
    'Reserved to BSI(22)',
    'Reserved to BSI(23)',
    'Reserved to BSI(24)',
    'Reserved to BSI(25)',
    'Reserved to BSI(26)',
    'Reserved to BSI(27)',
    'Reserved to BSI(28)',
    'Reserved to BSI(29)',
    'Reserved to BSI(30)', // 30
    'Reserved to BSI(31)',
    'Reserved to BSI(32)',
    'Reserved to BSI(33)',
    'Reserved to BSI(34)',
    'Reserved to BSI(35)',
    'Reserved to BSI(36)',
    'Reserved to BSI(37)',
    'Reserved to BSI(38)',
    'Reserved to BSI(39)',
    'Reserved to BSI(40)', // 40
    'Reserved to BSI(41)',
    'Reserved to BSI(42)',
    'Reserved to BSI(43)',
    'Reserved to BSI(44)',
    'Reserved to BSI(45)',
    'Reserved to BSI(46)',
    'Reserved to BSI(47)',
    'Reserved to BSI(48)',
    'Reserved to BSI(49)',
    'Reserved to BSI(50)', // 50
    'Reserved to BSI(51)',
    'Reserved to BSI(52)',
    'Reserved to BSI(53)',
    'Reserved to BSI(54)',
    'Reserved to BSI(55)',
    'Reserved to BSI(56)',
    'Reserved to BSI(57)',
    'Reserved to BSI(58)',
    'Reserved to BSI(59)',
    'Reserved to BSI(60)', // 60
    'Reserved to BSI(61)',
    'Reserved to BSI(62)',
    'Reserved to BSI(63)',
    'Reserved to BSI(64)',
    'Reserved to BSI(65)',
    'Reserved to BSI(66)',
    'Reserved to BSI(67)',
    'Reserved to BSI(68)',
    'Reserved to BSI(69)',
    'Reserved to BSI(70)', // 70
    'Reserved to BSI(71)',
    'Reserved to BSI(72)',
    'Reserved to BSI(73)',
    'Reserved to BSI(74)',
    'Reserved to BSI(75)',
    'Reserved to BSI(76)',
    'Reserved to BSI(77)',
    'Reserved to BSI(78)',
    'Reserved to BSI(79)',
    'Proprietry(80)', // 80
    'Proprietry(81)',
    'Proprietry(82)',
    'Proprietry(83)',
    'Proprietry(84)',
    'Proprietry(85)',
    'Proprietry(86)',
    'Proprietry(87)',
    'Proprietry(88)',
    'Proprietry(89)',
    'Proprietry(90)', // 90
    'Proprietry(91)',
    'Proprietry(92)',
    'Proprietry(93)',
    'Proprietry(94)',
    'Proprietry(95)',
    'Proprietry(96)',
    'Proprietry(97)',
    'Proprietry(98)',
    'Proprietry(99)',
], { default: 0, format: '00', other: 'Reserved to BSI' });

nowip.Heartbeat = Heartbeat;
Heartbeat.fields = Object.assign(['controller', 'unit'], {
    regex: /^(\d{8})(\d{4})$/,
});
function Heartbeat(data) { // CCCCCCCCRRRR
    if (this instanceof Heartbeat === false)
        return new Heartbeat(data);
    return nowip.parse(data, Heartbeat.fields, this);
}

nowip.Alarm = Alarm;
function Alarm(data) { // CDTTGGGGGGGGRRRREEELLPSS
    if (this instanceof Alarm === false)
        return data && new Alarm(data);
    return nowip.parse(data, nowip.parse.fields, this);
}

nowip.parse = parse;
parse.fields = Object.assign(['system', 'speech', 'conformance', 'controller', 'unit', 'event', 'location', 'priority', 'status'], {
    regex: /^(\d)(\d)(\d{2})(\d{8})(\d{4})(\d{3})(\d{2})(\d)(\d{2})$/,
});
parse.cunit = Object.assign(['system', 'speech', 'conformance', 'controllerunit', 'event', 'location', 'priority', 'status'], {
    regex: /^(\d)(\d)(\d{2})(\d{12})(\d{3})(\d{2})(\d)(\d{2})$/,
});
function parse(data, fields, self) {
    if (typeof fields === 'string') { // (string, string, ?object)
        fields = Object.assign(fields.split(/, */), { regex: '' });
        console.log('fields:', fields);
        for (var i = 0; i < fields.length; ++i) {
            console.log('field:', fields[i], (nowip[fields[i]] || {}).format);
            if (typeof (nowip[fields[i]] || {}).format === 'string')
                fields.regex += '(\\d{' + nowip[fields[i]].format.length + '})';
            else
                delete fields[i];
        }
        console.log('regex:', fields.regex);
        fields.regex = new RegExp('^' + fields.regex + '$');
    } else if (!Array.isArray(fields)) { // string, ?array, ?object)
        self = fields;
        fields = parse.fields;
    }
    var match = data.match(fields.regex);
    return match ? Object.defineProperties(fields.filter(Boolean).reduce(function (wksp, field, idx, arr) {
        if (nowip[field][+match[1 + idx]])
            wksp[field] = nowip[field][+match[1 + idx]];
        else if (nowip[field].other)
            wksp[field] = nowip[field].other + '(' + +match[1 + idx] + ')';
        else
            wksp[field] = +match[1 + idx];
        wksp.$[field] = match[1 + idx];
        return wksp;
    }, Object.assign(self || {}, { raw: match[0], $: {} })), { raw: { enumerable: false }, $: { enumerable: false } }) : null;
}

nowip.stringify = stringify;
function stringify(data, fields) {
    if (typeof fields === 'string') { // (string, string, ?object)
        fields = Object.assign(fields.split(/, */), { regex: '' });
        console.log('fields:', fields);
        for (var i = 0; i < fields.length; ++i) {
            console.log('field:', fields[i], (nowip[fields[i]] || {}).format);
            if (typeof (nowip[fields[i]] || {}).format === 'string')
                fields.regex += '(\\d{' + nowip[fields[i]].format.length + '})';
            else
                delete fields[i];
        }
        console.log('regex:', fields.regex);
        fields.regex = new RegExp('^' + fields.regex + '$');
    } else if (!Array.isArray(fields)) { // string, ?array, ?object)
        fields = data.controllerunit ? parse.cunit : parse.fields;
    }
    return fields.reduce(function (wksp, field, idx, arr) {
        var format = nowip[field].format, index, regex = nowip[field].other && nowip[field].other + ' *\\((\\d+)\\)', match;
        if (!isNaN((data.$ || {})[field])) { // numeric data.$[field]
            //console.log({ field: field, numeric: data.$[field] });
            wksp += (format + +data.$[field]).slice(-format.length);
        } else if (!isNaN(data[field])) { // numeric data[field]
            //console.log({ field: field, provided: data[field] });
            wksp += (format + data[field]).slice(-format.length);
        } else if ((index = nowip[field].indexOf(data[field])) >= 0) { // recognised data[field]
            //console.log({ field: field, recognised: data[field], index: index });
            wksp += (format + index).slice(-format.length);
        } else if (regex && (match = new RegExp('^' + regex + '$').exec(data[field]))) { // other'ised
            //console.log({ field: field, otherised: data[field], regex: regex, match: match });
            wksp += (format + +match[1]).slice(-format.length);
        } else if (isNaN(data[field])) { // unrecognised string, so go with default
            //console.log({ field: field, unrecognised: data[field], default: nowip[field].default, regex: regex, match: match });
            wksp += (format + nowip[field].default).slice(-format.length);
        }
        return wksp;
    }, '');
}

nowip.atm = atm;
function atm(js) {
    var type;
    if (!js.ATM || !Array.isArray(js.ATM.type))
        return;
    var type = atm.types[type = js.ATM.type[0]];
    if (typeof type === 'string')
        return type;
    if (typeof type === 'function' && Array.isArray(js.ATM.data))
        return type.call(this, js, js.ATM.data[0]);
}
Object.assign(atm, {
    types: { // from BS8521-2 table 10
        //'0': function heartbeat(evt) { },
        //'1': function alarm(evt) { },
        '2': function command(js, data) {
            var data0 = data[0], datas = command.datas[data0];
            if (typeof datas === 'string')
                return datas;
            if (typeof datas === 'function')
                return datas.call(this, js, data.slice(1));
        },
        //'5': function reject(evt) { },
        //'6': function busy(evt) { },
        //'7': function commanded(evt) { },
        //'8': function program(evt) { },
        //'9': function programed(evt) { },
        'A': 'atmAcknowledgement',
    },
});
Object.assign(atm.types['2'], {
    datas: { // from BS8521-2 table 11
        '2': function control(js, data1) {
            if (data1.slice(0, 2) !== '00')
                return;
            var action = control.actions[data1.slice(2, 4)];
            if (typeof action === 'string')
                return action;
            if (typeof action === 'function')
                return action.call(this, js)
        },
    },
});
Object.assign(atm.types['2'].datas['2'], {
    actions: { // from BS8521-2 table 7
        //'00': 'atmCommandControlUnsupported00',
        '01': 'atmCommandControlRelease1',
        '02': 'atmCommandControlRelease2',
        '03': 'atmCommandControlReleaseKeysafe',
        '04': 'atmCommandControlReleaseAll',
        //'05': 'atmCommandControlReserved05',
        '06': 'atmCommandControlRelay1on',
        '07': 'atmCommandControlRelay1off',
        '08': 'atmCommandControlRelay2on',
        '09': 'atmCommandControlRelay2off',
        '10': 'atmCommandControlSwitchLocal',
        '11': 'atmCommandControlSwitchARC',
        //'12': 'atmCommandControlReserved12',
        '13': 'atmCommandControlInactivityOn',
        '14': 'atmCommandControlInactivityOff',
        '15': 'atmCommandControlIntruderOn',
        '16': 'atmCommandControlIntruderOff',
        '17': 'atmCommandControlHypothermiaOn',
        '18': 'atmCommandControlHypothermiaOff',
        '19': 'atmCommandControlThermalFast',
        '20': 'atmCommandControlThermalSlow',
        '21': 'atmCommandControlTimeDeltaPlus1hr',
        '22': 'atmCommandControlTimeDeltaBack1hr',
        '23': 'atmCommandControlMonitorReset',
        '24': 'atmCommandControlMonitorProbe',
        '25': 'atmCommandControlTestCall',
        //'26-29': function reserved',
        '30': 'atmCommandControlUnitSuspend',
        '31': 'atmCommandControlUnitResume',
        '32': 'atmCommandControlProgramExit',
        //'33-79': function reserved',
        //'80-99': function proprietry',
    },
});
