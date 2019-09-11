#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('esl');
var extend = require('node.extend');
var js2xml = new (require('xml2js')).Builder({ headless: true, renderOpts: null });
var main = require.main.exports;
var modesl = require('modesl');
var os = require('os');
var setFunctionName = require('./name-function');

var recoverMs = 0; // grows in 1s increments to a hardcoded maximum
var timeout = undefined; // used for lost-connection recovery
module.exports = extend(exports, {
    apiX: null,                             // placeholder for re-packaged modesl method to use callbacks with err first argument
    atm: atm,                               // method to build & send a nowip ATM message
    authX: null,                            // placeholder for re-packaged modesl method to use callbacks with err first argument
    bgapiX: null,                           // placeholder for re-packaged modesl method to use callbacks with err first argument
    dialstring: dialstring,                 // method to build a dialstring from available uris
    executeX: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
    executeAsyncX: null,                    // placeholder for re-packaged modesl method to use callbacks with err first argument
    Event: modesl.Event,                    // convenience exposure
    history: extend([], { limit: 100 }),    // limited history of recent freeswitch events
    messageX: null,                         // placeholder for re-packaged modesl method to use callbacks with err first argument
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

process.once('running', start); // establish a freeswitch connection
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
    this.__proto__.on && this.__proto__.on(event.handler);
}

function abortJobs() { // called on socket closure to ensure no callbacks are left hanging
    var cb;
    while (this.cmdCallbackQueue.length) // sendRecv-jobs (sendEvent, filter, filterDelete, events, auth)
        (cb = this.cmdCallbackQueue.shift()) && cb.call(this);
    while (this.apiCallbackQueue.length) // api-jobs
        (cb = this.apiCallbackQueue.shift()) && cb.call(this);
    for (var jobid in this.listenerTree.esl.event.BACKGROUND_JOB) // bgapi-jobs
        this.emit('esl::event::BACKGROUND_JOB::' + jobid);
    for (var uuid in this.listenerTree.esl.event.CHANNEL_EXECUTE_COMPLETE) // bgapi-jobs
        this.emit('esl::event::CHANNEL_EXECUTE_COMPLETE::' + uuid);
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
    if (evt) {
        evt.event || (evt.event = this && this.event);
        if (evt.headers && !Array.isArray(evt.headers)) // already parsed
            return evt;
    }
    exports.history.push(evt || (evt = { headers: [], event: this && this.event }));
    parseEvt.debug(evt.headers.length, evt.event);
    if (hdrs && hdrs['Content-Type'] === 'text/event-json')
        evt.headers = Object.setPrototypeOf(JSON.parse(body), evt.headers);
    else
        evt.headers = Object.create(evt.headers);
    if (!Object.keys(evt.headers).length)
        for (var i in evt.headers.__proto__)
            evt.headers[evt.headers.__proto__[i].name] = evt.headers.__proto__[i].value;
    if (exports.history.length > exports.history.limit && evt.type === 'HEARTBEAT')
        exports.history.limit && exports.history.splice(0, exports.history.length - exports.history.limit);
    return evt;
}

// re-package modesl methods to expect callbacks with err first arguments
['auth', 'show'].forEach(function (name, idx, arr) {
    var nameX = name + 'X';
    exports[nameX] = setFunctionName(nameX, function (/* ..., */ cb) { // already expects callbacks taking err as a first argument
        return this.__proto__[name].apply(this.__proto__, arguments);
    });
});
['api', 'bgapi', 'execute', 'executeAsync', 'message', 'originate', 'sendEvent', 'sendRecv', 'subscribe'].forEach(function (name, idx, arr) {
    var nameX = name + 'X';
    exports[nameX] = setFunctionName(nameX, function (/* ..., */ cb) { // expects callbacks not taking err as a first argument
        var args = Array.from(arguments);
        cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : function () { };
        args.push(function (evt, hdrs, body) {
            if (!evt) // aborted
                return cb(new Error(nameX + 'aborted'));
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

//                  (sips:)?((user       )  (:passwd)?    @)?(host                 )  (:port )?   (;param         (=value     )?)* (  (?header      =value     )(&header    =value     )* )?
parseUri.re = /(?:(sips?):)?(?:([^\s>:@]+)(?::([^\s@>]+))?@)?([\w\-\./]+|\[[\w:]+\])(?::(\d+))?((?:;[^\s=\?>;,]+(?:=[^\s?\;,]+)?)*)(?:\?(([^\s&=>,]+=[^\s&=>,]+)(&[^\s&=>,]+=[^\s&=>,]+)*))?/g;
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
        if (typeof this[key] === 'string' && this[key].includes(' '))
            this[key] = "'" + this[key] + "'";
        return key + '=' + this[key];
    }, options).join(',');
    return list ? (prefix + list + suffix) : suffix.slice(1);
}

// this function takes the output of parseUris() which is parseCsv.bind(0, parseUri)
// which in turn takes a comma-seperated list of any of the following example URI formats:
//  user/1000               - digits:1000 as a registered user
//  group/1000              - digits:1000 as a group of registered users
//  default/1000            - digits:1000 via gateway:default
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
                uri.dialstring = host ? 'sofia/external/' + uri.user + host : undefined;
                break;
            case 2:// profile/user or user/dest or group/dest
                uri.dialstring = ~uri.user.search(/^group\/|user\//) ? uri.user : host ? 'sofia/' + uri.user + host : undefined;
                break;
            case 3:// gateway/gname/dest
                uri.dialstring = uri.user.startsWith('gateway/') ? uri.user : undefined;
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

atm.MESSAGE = { profile: 'sip_profile', from: 'to', to: { user: 'from_user', ip: 'from_sip_ip', port: 'from_sip_port', transport: 'from_full' } };
atm.CHANNEL = { profile: 'variable_sip_profile_name', from: 'variable_sip_from_uri', to: { user: 'variable_sip_to_user', ip: 'variable_sip_network_ip', port: 'variable_sip_network_port', transport: 'variable_sip_full_to' } };
atm.debug = debug.extend('atm');
function atm(evt, o, cb) { // evt, { ?type, ?data, ?blocking }
    var map = evt.type === 'MESSAGE' ? atm.MESSAGE : atm.CHANNEL;
    var transport = evt.getHeader(map.to.transport).match(/;transport=[-\w]+/);
    var event = new modesl.Event('custom', 'SMS::SEND_MESSAGE');
    o.blocking && event.addHeader('blocking', true);
    event.addHeader('proto', 'sip'); //*
    event.addHeader('dest_proto', 'sip');
    event.addHeader('from', 'sip:' + evt.getHeader(map.from));
    event.addHeader('from_full', 'sip:' + evt.getHeader(map.from));
    event.addHeader('sip_profile', evt.getHeader(map.profile));
    event.addHeader('subject', ''); //*
    event.addHeader('to', [
        'sip:',
        evt.getHeader(map.to.user) + '@',
        evt.getHeader(map.to.ip) + ':',
        evt.getHeader(map.to.port),
        transport ? transport[0] : '',
    ].join(''));
    event.addHeader('type', 'text/plain');
    event.addHeader('Content-Type', 'text/plain'); //*
    event.addBody(js2xml.buildObject({
        ATM: {
            version: ['1.5'],
            type: [o.type || 'A'],
            data: o.data && [o.data],
            time: [new Date().toJSON().slice(11, 19)],
            mac: [main.config.mac],
            wgs: o.wgs ? [o.wgs] : [],
        }
    }));
    atm.debug.enabled && atm.debug('atm:', event.serialize());
    exports.sendEventX(event, function (err, evt) {
        atm.debug.enabled && atm.debug('atmCb:', evt.serialize());
        cb && cb.apply(this, arguments);
    });

}
