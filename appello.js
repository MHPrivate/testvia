#! /usr/bin/env node-strict
process.env.DEBUG || (process.env.DEBUG = 'mysql');
process.setMaxListeners(15);

require('./lib/running').running = undefined; // causes main.running set _true_ once running AND _false_ when terminating
require('./lib/repletion')({ processGlobal: true, always: !process.stdin.isTTY }); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)

var callsites = require('callsites');
var fs = require('fs');

var main = Object.defineProperties(Object.assign(exports,{
    cache: {},      // slow-dynamic runtime context - e.g. SSL certificate(s)
    config: {},     // static global settings that are common between multiple instances on the same host
    control: {},    // dynamic runtime settings that broadly vary behaviour e.g. on/off site
    debug: require('debug'),    // for logging module administration
    global: global, // expose process global for repl-client connections
    hack: {},       // diagnostic runtime settings - usually empty
    identity: null, // typically https://<hostname>:<port> of this service instance
    modules: { // only for diagnostic accessibility - not to be used by code - use require(s) only
        aws: require('./lib/aws'),
        esl: require('./lib/esl'),
        fsxml: require('./lib/fsxml'),
        harvest: require('./lib/harvest'),
        ipsets: require('./lib/ipsets'),
        larcs: require('./lib/mesh/larcs'),
        mesh: require('./lib/mesh'),
        minut: require('./lib/minut'),
        mysql: require('./lib/mysql'),
        registrations: require('./lib/registrations'),
        rpscb: require('./lib/redis'), // redis -> rpscb (redis-pub-sub-callback)
        scabs: require('./lib/mesh/scabs'),
        web: require('./lib/web'),
    },
    secrets: require('./secrets.json'),
    setup: { // static instance settings variations that allow multiple instances on the same host e.g. port numbers
        https: +process.env.PORT || 8443,
    },
    state: {},      // fast-dynamic runtime context for detail tracking
    uuidv1: null,   // will be require('uuid').v1 bound to the primary system mac-address
}),{
    cluster: { enumerable: false },
    debug: { enumerable: false },
    global: { enumerable: false },
    modules: { enumerable: false },
    secrets: { enumerable: false },
});

process.once('terminate', function _main() {
    var unref = {
        'bound destroy': true, // WebSocket.close (/opt/appello-via/node_modules/ws/lib/websocket.js:243:24)
    }, setTimeout = global.setTimeout;
    global.setTimeout = function (cb, ms) { // intercept & unref particular timeout(s) set during shutdown
        if (ms && !unref[cb.name])
            console.log.apply(null, ['setTimeout:', '"' + cb.name + '"'].concat(Array.from(arguments)).concat('' + callsites()[1]));
        var timeout = setTimeout.apply(global, arguments); // set the timeout as requested
        return unref[cb.name] ? timeout.unref() : timeout; // unref specific timeouts
    };
    setInterval(function activeHandles() {
        var activeHandles = process._getActiveHandles();
        activeHandles.forEach(function (h, idx, arr) {
            switch (h.constructor.name) {
                case 'Socket':
                    console.log('handle: Socket', h.fd || (h.server || {})._connectionKey || (h.server || {})._pipename, h._peername);
                    break;
                case 'Timer':
                    console.log('handle: Timer', h._list._idleNext._onTimeout.toString());
                    break;
                default:
                    console.log('handle:', h.constructor.name);
            }
        });
    }, 10000).unref();
});

process.nextTick(function (nics) {
    for (var nic in nics) // lo, ens160, ens192
        for (var idx in nics[nic]) // 0, 1, 2, ...
            if (!nics[nic][idx].internal) { // external
                main.config.mac = nics[nic][idx].mac;
                main.uuidv1 = require('uuid/v1').bind(null, { node: Buffer.from(main.config.mac.replace(/:/g, ''), 'hex') })
                return;
            }
}, require('os').networkInterfaces());
