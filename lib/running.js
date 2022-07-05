#! /usr/bin/env node-strict
// use prevailing debug when available
var debug = function () { }; try { debug = require('debug')('running'); } catch (ex) { };
var main = module.exports = (require.main || {}).exports || exports; // try to have _require_ return the _exports_ of <main>.js

process.on('SIGHUP', debug.bind(null, 'SIGHUP')); // protect against unhandled 'systemctl reload <service>'
process.once('exit', debug.bind(null, 'exit')); // nodejs-core
process.terminate = process.emit.bind(process, 'terminate');
process.nextTick(process.emit.bind(process, 'running:loaded')); // called once sources finish loading

var terminators = [ // process-events to that call terminate()
    'SIGINT', // console-app CTRL-C
    'SIGTERM', // systemctl stop <service>
    'beforeExit', // nodejs-core
];
for (var i in terminators) // setup listeners for termination
    process.addListener(terminators[i], process.terminate);

process.running = new Promise(function loading(resolution, rejection) {
    debug('loading:');
    process.once('running:loaded', function running() {
        debug('running');
        if ('running' in main) {
            main.global || (main.global = global);
            main.running = true;
        }
        process.running.then(process.emit.bind(process, 'running:wait')); // invoked after any other thenings
        resolution(new Date);
    });
});

process.running.wait = [];
process.running.ready = new Promise(function wait(resolution, rejection) {
    process.once('running:wait', function run() {
        debug('waiting:', process.running.wait.length);
        Promise.all(process.running.wait).then(function ready() {
            debug('ready:');
            resolution(new Date);
        });
    });
});

process.once('terminate', function _running() { // cleans-up listeners to prevent multiple invokes
    debug('terminate');
    for (var i in terminators) // cleanup to prevent repeats
        process.removeListener(terminators[i], process.terminate);
    if ('running' in main)
        main.running = false;
});
