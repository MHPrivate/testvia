#! /usr/bin/env node-strict
var main = process.mainModule.exports;
var path = require('path');
var repl = require('repl');
var replify = require('replify');
var util = require('util');

require('./running'); // ensure _process_ 'running' & 'terminate' events are emitted

// function to alter default behaviour of module
module.exports = function (options, always) { // both optional
    if (typeof options !== 'object') // _options_ missing
        always = options; // _always_ also maybe missing
    else // options present
        util._extend(module.exports.options, options); // merge into running options
    if (always !== undefined) // _always_ is present
        signal.always = always;
    if (!signal.replify && signal.always) // not active AND _always_ is true
        signal.replify = replify(module.exports.options);
    return module.exports;
}

process.on('SIGUSR1', module.exports.signal = signal); // signal to toggle/refresh the connector
function signal() {
    if (signal.replify) // already active
        signal.replify.close() // so deactivate
    if (!signal.replify || signal.always) // was inactive OR _always_ is true
        signal.replify = replify(module.exports.options); // so activate
    else // was active AND not _always_
        delete signal.replify; // so discard deactivation
}

if (signal.always = +process.env.REPLIFY)
    signal();

module.exports.options = { // default replify options
    contexts: { main: main }, // expose mainModule.exports
    name: path.basename(process.mainModule.filename, '.js'), // use app-name
    path: '/run', // path for connector
};

process.once('terminate', function _replify() { // action to deactivate replify
    if (signal.replify) // currently active
        signal.replify.close(); // so deactivate
    delete signal.replify; // discard deactivation
});

process.stdin.isTTY && process.once('running', function () {
    util._extend(repl.start({
        prompt: module.exports.options.name + '> ',
    }).on('exit', function () {
        module.exports.options.noexit || process.emit('SIGTERM');
    }).context, module.exports.options.contexts);
});
