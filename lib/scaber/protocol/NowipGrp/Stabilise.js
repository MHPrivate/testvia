// NowIPGrp Stabilise simply prepares data to be used by other substates to send esl.atm messages
var chain = require('scope-chain'),
    debug,
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

    require('util').inherits(module.exports = exports = Stabilise, require('../../../state-machine'));

function Stabilise(leg, conclude) {
    debug || (debug = module.parent.exports.debug.extend(Stabilise.name.toLowerCase()));
    if (this instanceof Stabilise === false)
        throw new Error('Constructor Protocol:NowipGrp:' + Stabilise.name + ' requires \'new\'');

    Stabilise.super_.call(this, Stabilise, { // instance setup
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        verified: true,             // since we are just preparing the esl.atm data
    }); // this, ?initial, ?assign, ?enterArgs...
}

Object.assign(Stabilise, { // class setup
    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        this.leg.grouped = this.leg.callback.to_unit ? {unit: undefined} : undefined;
        this.leg.session.payload.protocol = 'NOWIP';
        this.leg.session.payload.bs8521 = {$: {}};

        // sipUser is used to build an "event" message which will be used to send the ATM message using esl.atm
        // If there is no this.leg.sipUser, we are in the AWS enviromnent in which case we send messages to Kamailio
        const sipUser = this.leg.sipUser || { profile: 'ext4udp', reg_user: this.leg.callback.to_number, hostname: 'lgw.lon.appello.cloud', network_ip: 'lgw.lon.appello.cloud', network_port: 5069 }
   
        const nowIpEvt = {
            type: 'MESSAGE',
            headers: {
                to: this.leg.session.firstEvt.headers['Caller-Caller-ID-Number'] + '@' + sipUser.hostname,
                from_user: sipUser.reg_user,
                from_sip_ip: sipUser.network_ip,
                from_sip_port: sipUser.network_port,
                from_full: '<sip:' + sipUser.reg_user + '@' + sipUser.hostname + '>',
                sip_profile: sipUser.profile
            }
        }

        this.leg.nowIpEvt = nowIpEvt;  // Store for use later
        this.leg.session.signal('tag', [sipUser.reg_user]);

        // Dont't call leave synchronously i.e. this.signal('leave'); as this will immediately trigger the conclude callback and create a new Generic substate before the
        // Stabilise substate has finished => before enter: returns.
        // The Generic substate creation will finish *before* the Stabilise substate creation, and so Stabilise (the last to return) will be set as the active substate.
        // Having an aysnc timeout (even 0) allows Stabilise to completely finish its creation before conclude is called and the Generic substate is created.
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'leave'), 0);
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, 'leave: aborted');

        debug(this.leg.session.sid, 'leave:');
        this.conclude && this.conclude(this.verified ? 'verified' : 'refused'); // Stabilise
        debug(this.leg.session.sid, 'leave:stabilised');
    },
    MESSAGE: function (msg) {
        debug(this.leg.session.sid, 'Unexpected MESSAGE:', msg.body);
        this.leg.session.enter(null);
        return this; 
    }
});