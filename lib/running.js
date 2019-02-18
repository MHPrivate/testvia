#! /usr/bin/env node-strict
// use prevailing debug - only if available
var debug; try { debug = require('debug')('running'); } catch (ex) { debug = function () { } };
var main = module.exports = (process.mainModule || {}).exports || global;

if (main) { // skip if require'd without a main script
    main.running = undefined;
    process.on('SIGHUP', Function.prototype); // protect against unhandled 'systemctl reload <service>'

    var terminators = [ // process-events to that call terminate()
        'SIGINT', // console-app CTRL-C
        'SIGTERM', // systemctl stop <service>
        'beforeExit', // nodejs-core
    ];
    function terminate() { // should only be invoked once
        for (var i in terminators) // cleanup to prevent repeats
            process.removeListener(terminators[i], terminate);
        process.emit('terminate');
    }
    for (var i in terminators) // 
        process.on(terminators[i], terminate);

    process.nextTick(process.emit.bind(process, 'running')); // called after all sources are loaded
    process.once('running', function running() {
        debug('running');
        main.running = true;
    });
    process.once('terminate', function _running() {
        debug('terminate');
        main.running = false;
    });
    process.once('exit', debug.bind(null, 'exit')); // nodejs-core
}
