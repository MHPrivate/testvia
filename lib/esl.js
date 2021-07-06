#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('esl');
var js2xml = new (require('xml2js')).Builder({ headless: true, renderOpts: null });
var limit = require('./limit');
var main = require.main.exports;
var modesl = require('modesl');
var mysql = require('./mysql');
var os = require('os');
var setFunctionName = require('./name-function');

var recoverMs = 0; // grows in 1s increments to a hardcoded maximum
var timeout = undefined; // used for lost-connection recovery
module.exports = Object.assign(exports, { // connection is dynamically assigned as export's Prototype
    apiX: null,                             // placeholder for re-packaged modesl method to use callbacks with err first argument
    atm: atm,                               // method to build & send a nowip ATM message
    authX: null,                            // placeholder for re-packaged modesl method to use callbacks with err first argument
    bgapiX: null,                           // placeholder for re-packaged modesl method to use callbacks with err first argument
    dialstring: dialstring,                 // method to build a dialstring from available uris
    executeX: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
    executeAsyncX: null,                    // placeholder for re-packaged modesl method to use callbacks with err first argument
    Event: modesl.Event,                    // convenience exposure
    history: limit(100),                    // limited history of recent freeswitch events
    messageX: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
    mrs: mrs,                               // method to build & send a scaip MRS message
    nvp: nvp,                               // method to assemble name-value-pairs for freeswitch dialstrings
    on: on,                                 // method to gather event-handlers in advance of esl-connection
    originateX: null,                       // placeholder for re-packaged modesl method to use callbacks with err first argument
    newListener: debug.enabled,             // modesl control flag to activate 'newListener' emits
    parseCsv: parseCsv,
    parseEvt: parseEvt,                     // method to re-cast evt:headers as a dictionary
    parseUris: parseCsv.bind(0, parseUri),  // method to parse a SIP uri
    sendEvent: null,                        // placeholder for re-packaged modesl method to use callbacks with err first argument
    sendRecv: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
    showX: null,                            // placeholder for re-packaged modesl method to use callbacks with err first argument
    subscribeX: null,                       // placeholder for re-packaged modesl method to use callbacks with err first argument
});

process.running.then(start); // establish a freeswitch connection
process.once('terminate', function _esl() {
    timeout = clearTimeout(timeout) || true; // prevents a new call to setTimeout()
    exports.socket && exports.disconnect(); // unsets 'socket' before jobCallbacks
    abortJobs.call(exports);
});

function on(event, handler) {
    if (event in on.handlers === false)
        on.handlers[event] = handler;
    else if (Array.isArray(on.handlers[event]))
        on.handlers[event].push(on.handlers);
    else
        on.handlers[event] = [on.handlers[event], handler];
    this.__proto__.on && this.__proto__.on(event, handler);
}

function abortJobs() { // called on socket closure to ensure no callbacks are left hanging
    var cb, evtAborted = new modesl.Event;
    evtAborted.addBody('-Aborted\n');
    while (this.cmdCallbackQueue.length) // sendRecv-jobs (sendEvent, filter, filterDelete, events, auth)
        (cb = this.cmdCallbackQueue.shift()) && cb.call(this);
    while (this.apiCallbackQueue.length) // api-jobs
        (cb = this.apiCallbackQueue.shift()) && cb.call(this);
    for (var jobid in this.listenerTree.esl.event.BACKGROUND_JOB) // bgapi-jobs
        this.emit('esl::event::BACKGROUND_JOB::' + jobid, evtAborted);
    for (var uuid in this.listenerTree.esl.event.CHANNEL_EXECUTE_COMPLETE) { // execute-jobs
        this.emit('esl::event::CHANNEL_EXECUTE_COMPLETE::' + uuid, evtAborted);
    }
}

function start() { // establish a freeswitch connection
    timeout = clearTimeout(timeout);
    exports.socket || chain(function cleanup(err) {
        err && console.log('esl: fail:', err);

    }, function () {
        var secrets = main.secrets || { freeswitch: {} };
        Object.setPrototypeOf(exports, new modesl.Connection('localhost', 8021, secrets.freeswitch[os.hostname()] || secrets.freeswitch.default || 'ClueCon', this));
        for (var event in handlers)
            if (!Array.isArray(handlers[event])) // add single handler
                exports.__proto__.on(event, handlers[event]); // ensure we don't call our own on() method
            else for (var i in handlers[event]) // add multiple handlers
                exports.__proto__.on(event, handlers[event][i]); // ensure we don't call our own on() method

    }, function () {
        recoverMs = 0; // successful connection - reset the backoff delay
        exports.__proto__.subscribe('all', this.noerror); // cb(evt, hdrs, body)

    });
};

var handlers = on.handlers = {
    newListener: function (type, handler) { // only functions if exports.newListeners is set
        console.log('esl: newListener:', type);
    },
    error: function onError(err) {
        if ((this.socket || {}).destroyed) { // cleanup if this error destroyed the socket
            this.socket = null;
            abortJobs.call(this);
        }
        switch (err.code) {
            case 'ECONNREFUSED': // log AND initiate connection recovery
            case 'ECONNRESET':
                timeout = timeout || setTimeout(start, recoverMs += (recoverMs < 5000) * 1000);
                console.log('esl: error:', err.message, recoverMs);
                break;
            default: // just log
                console.log('esl: error:', err);
                break;
        }
    },
    'esl::end': function onEslEnd() { // freeswitch clean-shutdown - initiate connection recovery
        timeout = timeout || setTimeout(start, recoverMs += (recoverMs < 5000) * 1000);
        abortJobs.call(this);
    },
    'esl::**': function onEsl(evt, hdrs, body) { // catch-all event processing (e.g. history)
        debug.enabled && parseEvt.call(this, evt, hdrs, body);
    },
};

parseEvt.debug = debug.extend('parse');
function parseEvt(evt, hdrs, body) { // transform evt.headers to dictionary "evt = parseEvt.call(this, evt, hdrs, body);"
    var hr = process.hrtime();
    if (evt) {
        evt.event || (evt.event = this && this.event);
        if (evt.headers && !Array.isArray(evt.headers)) // already parsed
            return evt;
    }
    limit(exports.history, evt || (evt = { headers: [], event: this && this.event }));
    parseEvt.debug(evt.headers.length, evt.event);
    if (hdrs && hdrs['Content-Type'] === 'text/event-json')
        evt.headers = Object.setPrototypeOf(JSON.parse(body), evt.headers);
    else
        evt.headers = Object.create(evt.headers);
    if (!Object.keys(evt.headers).length)
        for (var i in evt.headers.__proto__)
            evt.headers[evt.headers.__proto__[i].name] = evt.headers.__proto__[i].value;
    if (evt.headers['Event-Date-Timestamp'])
        evt.when = new Date(evt.headers['Event-Date-Timestamp'] / 1000);
    hr = process.hrtime(hr);
    evt.parseNs = hr[0] * 1000000000 + hr[1];
    return evt;
}

// re-package modesl methods to expect callbacks with err first arguments
['auth', 'show'].forEach(function (name, idx, arr) { // authCb(err, evt) ; showCb(err, parsed, data)
    var nameX = name + 'X';
    exports[nameX] = setFunctionName(nameX, function (/* ..., */ cb) { // original callback already delivers an err first argument
        return this.__proto__[name].apply(this.__proto__, arguments);
    });
});
['api', 'bgapi', 'execute', 'executeAsync', 'message', 'originate', 'sendEvent', 'sendRecv', 'subscribe'].forEach(function (name, idx, arr) { // cb(evt, hdrs, body)
    var nameX = name + 'X';
    exports[nameX] = setFunctionName(nameX, function (/* ..., */ cb) { // recast original err'less callback to insert an err=null first argument
        var args = Array.from(arguments);
        cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : function () { };
        args.push(function (evt, hdrs, body) {
            if (!evt) // aborted
                return cb(new Error(nameX + ' aborted'));
            parseEvt.call(this, evt, hdrs, body);
            cb.call(this, null, evt, hdrs, body);
        });
        return this.__proto__[name].apply(this.__proto__, args);
    });
});

function applyRegex(regex, data) { // helper for parseUri & parseCsv
    data.i = data.i || 0;
    regex.lastIndex = data.i;
    var r = regex.exec(data.s);

    if (r && (r.index === data.i)) {
        data.i = regex.lastIndex;
        return r;
    }
}

//                  (sips:)?((user       )  (:passwd   ) ?@)?(host                 )  (:port )?   (;param         (=value     )?)* (  (?header      =value     )(&header    =value     )* )?
parseUri.re = /(?:(sips?):)?(?:([^\s>:@]+)(?::([^\s@>]+))?@)?([\w\-\./+]+|\[[\w:]+\])(?::(\d+))?((?:;[^\s=\?>;,]+(?:=[^\s?\;,]+)?)*)(?:\?(([^\s&=>,]+=[^\s&=>,]+)(&[^\s&=>,]+=[^\s&=>,]+)*))?/g;
function parseUri(data) { // e.g. 'sip:user:passwd@host:5060;transport=udp?usr=usr&pwd=pwd' or 'external/user@[fe80::]:5070'
    typeof data === 'string' && (data = {
        s: data,
        i: 0
    });

    var r = applyRegex(parseUri.re, data);

    if (r) {
        return {
            schema: r[1],
            user: r[2] || ((r[4] || '').includes('/') ? r[4] : undefined),
            password: r[3],
            host: ((r[4] || '').includes('/') && !r[2]) ? undefined : r[4],
            port: +r[5], // r[5] ? +r[5] : 5060,
            params: (r[6].match(/([^;=]+)(=([^;=]+))?/g) || []).map(function (s) {
                return s.split('=');
            }).reduce(function (params, x) {
                params[x[0]] = x[1] || null;
                return params;
            }, {}),
            headers: ((r[7] || '').match(/[^?&=]+=[^?&=]+/g) || []).map(function (s) {
                return s.split('=');
            }).reduce(function (params, x) {
                params[x[0]] = x[1];
                return params;
            }, {})
        };
    }
}

parseCsv.re = /\s*,\s*/g;
function parseCsv(parser, data, hdr) {
    hdr = hdr || [];
    typeof (data) === 'string' && (data = {
        s: data,
        i: 0
    });

    do {
        hdr.push(parser(data));
    } while (data.i < data.s.length && applyRegex(parseCsv.re, data));

    return hdr;
}

nvp.debug = debug.extend('nvp');
function nvp(options, prefix, suffix) {
    //  <variable_scope=super-global>
    //      {variable_scope=thread1}
    //          [variable_scope=leg1a]<target_endpoint>
    //          [,[variable_scope=leg1b]<target_endpoint>]      (, is serial-dialing)
    //          [|<target_endpoint>]                            (| is parallel-dialing)
    //      :_:{variable_scope=thread2}                         (:_: is enterprise-parallel-dialing)
    //          [variable_scope=leg2a]<target_endpoint>
    //          [,[variable_scope=leg2b]<target_endpoint>]
    //          [|<target_endpoint>]
    options = options || {};
    if (Array.isArray(prefix)) { // options, [prefix, suffix]
        suffix = prefix[1];
        prefix = prefix[0];
    } else if (prefix && !suffix) { // options, prefixSuffixString
        suffix = prefix.slice(1);
        prefix = prefix.slice(0, 1);
    } else { // options OR options, prefix, suffix
        suffix = suffix || '';
        prefix = prefix || '';
    }
    var list = Object.keys(options).sort().filter(function (key, idx, arr) {
        return this[key] !== undefined;
    }, options).map(function (key, idx, arr) {
        if (typeof this[key] === 'string' && ~this[key].search(/[ ,]/))
            this[key] = "'" + this[key] + "'"; // double-quotes don't work - only use single quotes
        return key + '=' + this[key];
    }, options).join(',');
    nvp.debug.enabled && nvp.debug(list ? (prefix + list + suffix) : suffix.slice(1));
    return list ? (prefix + list + suffix) : suffix.slice(1);
}

// this function takes the output of parseUris() which is parseCsv.bind(0, parseUri)
// which in turn takes a comma-seperated list of any of the following example URI formats:
//  user/1000               - digits:1000 as a registered user
//  group/1000              - digits:1000 as a group of registered users
//  gateway/gname/dest      - digits:1000 via gateway:default
//  1000@example.com:5066   - direct UDP invite via external profile
//  internal/1000@example.com:5066      - anonymous direct UDP invite via internal profile
//  1000@example.com:5067;transport=tls - anonymous direct TLS invite via external profile
//  1000@example.com?ausr=tom&apwd=cat  - direct UDP invite via external profile using tom/cat credentials
// the URIs for volt would be '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066'
function dialstring(uris) { // [{scheme,user,password,host,port,params,headers}, ...]
    return uris.map(function (uri, idx, arr) {
        if (!uri || !uri.user || uri.user.startsWith('.'))
            return;
        if (uri.scheme === 'sips')
            uri.params.transport = 'tls';
        var dialstring, host = uri.host ?  '@' + uri.host + (uri.port ? ':' + uri.port : '') : '';
        switch (uri.user.split(/\//).length) {
            case 1:// user-only
                uri.dialstring = host ? 'sofia/ext4udp/' + uri.user + host : undefined;
                break;
            case 2:// profile/user or user/dest or group/dest
                uri.dialstring = ~uri.user.search(/^group\/|^user\//) ? uri.user : host ? 'sofia/' + uri.user + host : undefined;
                break;
            case 3:// gateway/gname/dest
                uri.dialstring = uri.user.startsWith('gateway/') ? 'sofia/' + uri.user : undefined;
                break;
            default:// invalid
                break;
        }
        if (!uri.dialstring)
            return;
        for (var key in uri.params)
            uri.dialstring += ';' + key + '=' + uri.params[key];
        return uri;

    }).filter(function (uri, idx, arr) {
        return uri;

    }).map(function (uri, idx, arr) {
        return nvp({
            appello_more_legs: arr.length === 1 ? undefined : (arr.length - idx - 1),
            sip_auth_password: uri.headers.apass,
            sip_auth_username: uri.headers.auser,
        }, '[]' + uri.dialstring);

    }).join('|');
}

atm.debug = debug.extend('atm');
function atm(evt, o, cb) { // evt, { ?type, ?data, ?blocking, ?wgs }, cb(err, evt);
    o.xml = js2xml.buildObject({
        ATM: {
            version: ['1.5'],
            type: [o.type || 'A'],
            data: o.data && [o.data],
            time: [new Date().toJSON().slice(11, 19)],
            mac: [main.config.mac],
            e164: o.e164 ? [o.e164] : [],   // non-standard NOWIP item
            wgs: o.wgs ? [o.wgs] : [],      // non-standard NOWIP item
        }
    });
    atm.debug('base', evt.type, o.xml);
    exports.executeAsyncX('eval', ['${uuid_send_message(${uuid} ' + o.xml + ')}'], evt.headers['Unique-ID'], cb);
}

mrs.debug = debug.extend('mrs');
function mrs(evt, o, cb) { // evt, { ?type, ?data, ?blocking, ?wgs }, cb(err, evt);
    mrs.debug.enabled && mrs.debug('base', evt.type, evt.serialize());
    var transport = (evt.type === 'MESSAGE' ? evt.headers['from_full'] : evt.headers['variable_sip_req_uri']).match(/;transport=[-\w]+/);
    // CHANNEL_PROGRESS+CHANNEL_ANSWER: Caller-Caller-ID-Number
    // CHANNEL_ANSWER: variable_origination_caller_id_number
    var from = (evt.type === 'MESSAGE')
        ? evt.headers['to_user'] + '@' + evt.headers['to_host']
        : evt.headers['Caller-Caller-ID-Number'] + '@' + evt.headers['variable_sip_local_network_addr'];
    var event = new modesl.Event('custom', 'SMS::SEND_MESSAGE');
    o.blocking && event.addHeader('blocking', true);
    event.addHeader('proto', 'sip'); //*
    event.addHeader('dest_proto', 'sip');
    event.addHeader('from', 'sip:' + from);
    event.addHeader('from_full', 'sip:' + from);
    event.addHeader('sip_profile', (evt.type === 'MESSAGE') ? evt.headers['sip_profile'] : evt.headers['variable_sofia_profile_name']);
    event.addHeader('subject', ''); //*
    event.addHeader('to', (evt.type === 'MESSAGE' ? [
        'sip:',
        evt.headers['from_user'],
        '@',
        evt.headers['from_sip_ip'],
        ':',
        evt.headers['from_sip_port'],
        transport ? transport[0].toLowerCase() : '',
    ] : [
        'sip:',
        evt.headers['variable_sip_to_user'],
        '@',
        evt.headers['variable_sip_network_ip'],
        ':',
        evt.headers['variable_sip_network_port'],
        transport ? transport[0].toLowerCase() : '',
    ]).join(''));    event.addHeader('type', 'application/scaip+xml');
    event.addBody(o.xml = js2xml.buildObject({
        mrs: {
            ref: [o.ref],
            snu: [o.snu || 0],
            ste: !o.ste ? [] : [o.ste],
            cve: !o.cve ? [] : [o.cve],
            mre: !o.mre ? [] : [o.mre],
            cre: !o.cre ? [] : [o.cre],
            tnu: !o.tnu ? [] : Array.isArray(o.tnu) ? o.tnu : [o.tnu],
            hbi: !o.hbi ? [] : [o.hbi],
        }
    }));
    mrs.debug.enabled && mrs.debug('mesg', event.serialize());
    exports.sendEventX(event, function (err, evt) {
        mrs.debug.enabled && mrs.debug('resp', evt.serialize());
        cb && cb.apply(this, arguments);
    });
}
