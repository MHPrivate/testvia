#! /usr/bin/env node-strict
if (require('command-line-args')([ { name: 'fork', alias: 'f', type: Boolean } ]).fork) {
    return ['unref', 'disconnect'].forEach(function (fn) {
        this[fn]();
    }, require('child_process').fork(require.main.filename, { stdio: ['ignore', process.stdout, process.stderr, 'ipc'] }));
}

// scaber - social-call-alarm-broker
process.env.DEBUG || (process.env.DEBUG = 'mysql');
process.setMaxListeners(15);

var cluster = require('cluster');
require('./lib/running').running = undefined; // causes main.running set _true_ once running AND _false_ when terminating
require('./lib/repletion')({ processGlobal: true, always: !process.stdin.isTTY, pidify: !cluster.isMaster }); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)

global.UTIL = Object.assign(global.UTIL || {}, { // merge into any existing global UTIL object
    stringify: (function () { // a circular-reference safe alternative to JSON.stringify() for debug & console output
        var util = require('util');
        return function stringify(obj) {
            return util.inspect(obj, { breakLength: Infinity, depth: Infinity });
        }
    })(),
});

var fs = require('fs');
var main = Object.defineProperties(Object.assign(exports,  {
    cache: {},      // slow-dynamic runtime context - e.g. SSL certificate(s)
    cluster: cluster,   // process clustering module
    config: {},     // static global settings that are common between multiple instances on the same host
    control: {},    // dynamic runtime settings that broadly vary behaviour e.g. on/off site
    debug: require('debug'),    // for logging module administration
    global: global, // expose process global for repl-client connections
    hack: {},       // diagnostic runtime settings - usually empty
    modules: {},    // container for loadable functionality modules
    secrets: require('./secrets.json'),
    setup: {},      // static instance settings variations that allow multiple instances on the same host e.g. port numbers
    state: {},      // fast-dynamic runtime context for detail tracking
    uuidv1: null,   // will be require('uuid').v1 bound to the primary system mac-address
}), {
    cluster: { enumerable: false },
    debug: { enumerable: false },
    global: { enumerable: false },
    modules: { enumerable: false },
    secrets: { enumerable: false },
});

if (cluster.isMaster) {
    cluster.setupMaster({ stdio: ['ignore', process.stdout, process.stderr, 'ipc'] });
    cluster.fork(); // spawn 1st worker
    process.once('terminate', cluster.disconnect.bind(cluster)); // leads each worker to terminate
    process.on('SIGHUP', cluster.fork.bind(cluster)); // spawn another worker on SIGHUP
    Object.assign(main.modules, { // load master functionality
        master: require('./lib/scaber/master'),
        webio: require('./lib/scaber/webio'), // manages link to websvc
    });
} else {
    cluster.worker.on('disconnect', process.emit.bind(process, 'terminate')); // terminate on IPC disconnect
    process.once('terminate', cluster.worker.disconnect.bind(cluster.worker)); // cleanup IPC to master
    Object.assign(main.config, {
        Communicators: {
            assist: require('./lib/scaber/communicator-assist'),
            bs8521pnc: require('./lib/scaber/communicator-bs8521-pnc'),
            callback: require('./lib/scaber/communicator-callback'),
            detect: require('./lib/scaber/communicator-detect'), // bridge, guard, bs8521, tt92, ttnew, bsia, ttold
            nowip: require('./lib/scaber/communicator-nowip'),
            null: require('./lib/scaber/communicator-null'),
            scaip: require('./lib/scaber/communicator-scaip'),
            default: process.env.DEFAULT_COMMUNICATOR || 'detect',
        },
        Consumers: {
            bridge: require('./lib/scaber/consumer-bridge'),
            bs8521pnc: require('./lib/scaber/consumer-bs8521-pnc'),
            callback: require('./lib/scaber/consumer-callback'),
            nowipVolt: require('./lib/scaber/consumer-nowip-volt'),
            //nowipJontek: require('./lib/scaber/consumer-nowip-jontek'),
            simple: require('./lib/scaber/consumer-simple'),
            slsUser: require('./lib/scaber/consumer-slsuser'),
        },
    });
    Object.assign(main.modules, { // load worker functionality
        azure: require('./lib/azure'),
        detect2: null, // maintain alphabetic order, but load after 'worker'
        esl: require('./lib/esl'),
        mysql: require('./lib/mysql'),
        nowip: require('./lib/nowip'),
        rpscb: require('./lib/rpscb'),
        Session: require('./lib/scaber/session'),
        worker: require('./lib/scaber/worker'),

        detect2: require('./lib/scaber/protocol/Detect2'),
    });

}

process.nextTick(function (nics) {
    for (var nic in nics) // lo, ens160, ens192
        for (var idx in nics[nic]) // 0, 1, 2, ...
            if (!nics[nic][idx].internal) { // external
                main.config.mac = nics[nic][idx].mac;
                main.uuidv1 = require('uuid/v1').bind(null, { node: Buffer.from(main.config.mac.replace(/:/g, ''), 'hex') })
                return;
            }
}, require('os').networkInterfaces());
