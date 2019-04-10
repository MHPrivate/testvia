#! /usr/bin/env node-strict
// use prevailing debug when available
var debug = function () { }; try { debug = require('debug')('running'); } catch (ex) { };
var main = module.exports = (require.main || {}).exports || exports; // try to have _require_ return the _exports_ of <main>.js

process.on('SIGHUP', debug.bind(null, 'SIGHUP')); // protect against unhandled 'systemctl reload <service>'
process.once('exit', debug.bind(null, 'exit')); // nodejs-core

var terminators = [ // process-events to that call terminate()
    'SIGINT', // console-app CTRL-C
    'SIGTERM', // systemctl stop <service>
    'beforeExit', // nodejs-core
];
function terminate() { // cleans-up listeners to prevent multiple invokes
    for (var i in terminators) // cleanup to prevent repeats
        process.removeListener(terminators[i], terminate);
    process.emit('terminate');
}
for (var i in terminators) // setup listeners for termination
    process.addListener(terminators[i], terminate);

process.nextTick(process.emit.bind(process, 'running')); // called once sources finish loading
process.once('running', function running() {
    debug('running');
    if ('running' in main) {
        main.global || (main.global = global);
        main.running = true;
    }
});
process.once('terminate', function _running() {
    debug('terminate');
    if ('running' in main)
        main.running = false;
});
