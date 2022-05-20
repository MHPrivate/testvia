#! /usr/bin/env node-strict
var callsites = require('callsites'),
    debug = require('debug')('communicator:null'),
    worker = require('./worker');

require('util').inherits(module.exports = exports = CommunicatorNull, require('../state-machine'));
function CommunicatorNull(session, evt) {
    if (this instanceof CommunicatorNull === false)
        throw new Error('Constructor CommunicatorNull requires \'new\'');

    CommunicatorNull.super_.call(this, CommunicatorNull, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
    }, evt); // attach enter+signal methods and enter initial state
}

Object.assign(CommunicatorNull, {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorNullEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
    },
    leave: function onCommunicatorNullLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        this.session.signal('detached');
    },
});
