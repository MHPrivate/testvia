#! /usr/bin/env node-strict
if (require('command-line-args')([ { name: 'fork', alias: 'f', type: Boolean } ]).fork) {
    return ['unref', 'disconnect'].forEach(function (fn) {
        this[fn]();
    }, require('child_process').fork(require.main.filename, { stdio: ['ignore', process.stdout, process.stderr, 'ipc'] }));
}

// scaber - social-call-alarm-broker
process.env.DEBUG || (process.env.DEBUG = 'mysql');
process.setMaxListeners(15);

require('./lib/running').running = undefined; // causes main.running set _true_ once running AND _false_ when terminating
require('./lib/repletion')({ processGlobal: true, always: !process.stdin.isTTY, pidify: true }); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)

var cluster = require('cluster');
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
    main.config.Communicators = {
        assist: require('./lib/scaber/communicator-assist'),
        nowip: require('./lib/scaber/communicator-nowip'),
        scaip: require('./lib/scaber/communicator-scaip'),
    };
    Object.assign(main.modules, { // load worker functionality
        ConsumerNowipVolt: require('./lib/scaber/consumer-nowip-volt'),
        ConsumerNowipJontek: require('./lib/scaber/consumer-nowip-jontek'),
        esl: require('./lib/esl'),
        mysql: require('./lib/mysql'),
        Session: require('./lib/scaber/session'),
        Task: require('./lib/scaber/task'),
        worker: require('./lib/scaber/worker'),
    });
}

process.nextTick(function (nics) {
    for (var nic in nics) // lo, ens160, ens192
        for (var idx in nics[nic]) // 0, 1, 2, ...
            if (!nics[nic][idx].internal) // external
                return main.config.mac = nics[nic][idx].mac;
}, require('os').networkInterfaces());
