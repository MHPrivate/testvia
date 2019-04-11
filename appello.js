#! /usr/bin/env node-strict
process.env.DEBUG || (process.env.DEBUG = 'mysql');
//process.setMaxListeners(20);

require('./lib/running').running = undefined; // causes main.running set _true_ once running AND _false_ when terminating
require('./lib/repletion')(!process.stdin.isTTY); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)

var callsites = require('callsites');
var extend = require('node.extend');
var fs = require('fs');

var main = extend(exports, {
    secrets: JSON.parse(fs.readFileSync(__dirname + '/secrets.json', 'utf8')),
    setup: { // static instance settings variations that allow multiple instances on the same host e.g. port numbers
        https: +process.env.PORT || 8443,
    },
    config: {},     // static global settings that are common between multiple instances on the same host
    control: {},    // dynamic runtime settings that broadly vary behaviour e.g. on/off site
    state: {},      // fast-dynamic runtime context for detail tracking
    cache: {},      // slow-dynamic runtime context - e.g. SSL certificate(s)
    hack: {},       // diagnostic runtime settings - usually empty
    global: global, // the core global object - otherwise different for each replify client
    modules: {      // only for diagnostic accessibility - not to be used by code - use require(s) only
        debug: require('debug'),    // for logging module administration
        esl: require('./lib/esl'),
        ipsets: require('./lib/ipsets'),
        larcs: require('./lib/mesh/larcs'),
        mesh: require('./lib/mesh'),
        mysql: require('./lib/mysql'),
        peers: require('./lib/mesh/peers'),
        web: require('./lib/web'),
    },
});

process.once('terminate', function _main() {
    var unref = {
        'bound ': true, // _sender.close (/opt/appello-via/node_modules/ws/lib/websocket.js:231:28)
    }, setTimeout = global.setTimeout;
    global.setTimeout = function (cb, ms) { // intercept & unref particular timeout(s) set during shutdown
        if (ms && !unref[cb.name])
            console.log.apply(console, ['setTimeout:', '"' + cb.name + '"'].concat(Array.from(arguments)).concat('' + callsites()[1]));
        var timeout = setTimeout.apply(global, arguments); // set the timeout as requested
        return unref[cb.name] ? timeout.unref() : timeout; // unref specific timeouts
    };
    setInterval(function activeHandles() {
        var activeHandles = process._getActiveHandles();
        console.log(activeHandles);
        activeHandles.forEach(function (handle, idx, arr) {
            if (handle.__proto__.constructor.name === 'Timer') {
                (function recurse(timeout) {
                    recurse.cache = recurse.cache || [];
                    if (~recurse.cache.indexOf(timeout))
                        return;
                    recurse.cache.push(timeout);
                    console.log(timeout._onTimeout && timeout._onTimeout.toString(), timeout._idleTimeout);
                    recurse(timeout._idleNext);
                })(handle._list._idleNext);
            }
        });
    }, 10000).unref();
});
