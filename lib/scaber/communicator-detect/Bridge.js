#! /usr/bin/env node-strict
module.exports = new (function Bridge() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name;
var chain = require('scope-chain');
var debug = require('debug')(Variant.toLowerCase());
var esl = require('../../esl');
var main = require.main.exports;
var worker = require('../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    enter: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.enter:', JSON.stringify({ enterMs: Date.now() - this.communicator.answered }));
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.communicator.session.sid, 'Establish.leave:', JSON.stringify({ leaveMs: Date.now() - this.communicator.answered, conclusion: conclusion }));
        this.timeout = worker.resetTimeout(this.timeout);
        this.conclude(conclusion); // Establish
    },
    action: function () {
        var conclusion;
        switch ((this.communicator.session.context || {}).bridge) {
            case undefined: // missing 'bridge' - so refuse (this protocol) - start recording below
                conclusion = 'refused';
                break;

            case '': // empty 'bridge' - so release/deflect (the call) - start recording below
                conclusion = 'release';
                break;

            default: // presumably a useful 'bridge' target' - without recording to allow bypass_media
                conclusion = 'verified';
                break;
        }
        debug.enabled && debug(this.communicator.session.sid, 'Establish.action:', JSON.stringify({ actionMs: Date.now() - this.communicator.answered, conclusion: conclusion }));

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.action', err);
            sm.enter(null, conclusion);

        }, function () {
            if (conclusion === 'verified') // forward using bypass_media
                esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} forward'], sm.communicator.uuid, this);
            else if (conclusion === 'release') // deflect
                esl.executeAsyncX('bgsystem', ['$${conf_dir}/bin/add-suffix.sh ${record_file_path} deflect'], sm.communicator.uuid, this);
            else // proceed with next protocol
                esl.executeAsyncX('record_session', ['${record_file_path}'], sm.communicator.uuid, this);   

        });
        return this;
    },
});
