var argsMap = require('../args-map');
var debug = require('debug')('session');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = Session;

require('util').inherits(Session, require('../state-machine'));
function Session(evt, date) { // minimal evt is { headers: { 'Caller-Caller-ID-Number', variable_sip_call_id } }
    if (this instanceof Session === false)
        throw new Error('Constructor Session requires \'new\'');
    Session.super_.call(this, sessionState, {
        locals: Object.defineProperties({ // locals attributes
            alegEvt: evt, // CHANNEL_CREATE
            communicator: undefined, // presence of a Communicator indicates we are responsible for this alarm call
            consumers: Object.assign([], { index: NaN, tries: 1 }),
            fallbackUris: undefined,
            origin: evt.headers['Caller-Caller-ID-Number'],
            routes: [], // for cleanup when finished
            sid: '$' + evt.headers['Caller-Caller-ID-Number'] + '$' + evt.headers['variable_sip_call_id'],
            started: date || new Date,
            tasks: [],
            unique: evt.headers['variable_sip_call_id'],
        }, { // locals descriptors
            alegEvt: { enumerable: false },
            communicator: { enumerable: false },
            consumers: { enumerable: false },
            tasks: { enumerable: false },
        }),
    });
}

var sessionState = { // _this_ of all methods is the StateMachine instance
    enter: function onSessionEnter() {
        console.log('onSessionEnter', this.locals.alegEvt.type, this.locals.sid);
        var sm = this, offer = { event: 'offer', sid: this.locals.sid };
        debug.enabled && debug('<04 session:offer#' + worker.id, JSON.stringify(offer));
        worker.sendCb(offer, worker.handle, function offerCb(message, handle) { // _this_ is worker - {  ?err }, handle
            debug.enabled && debug.apply(0, [(!message.err ? '>08' : message.sibling ? '>06' : '>10') + ' session:offerCb#' + worker.id].concat(argsMap(arguments)));
            sm.signal('offerOutcome', !message.err); // offerOutcome(accepted:Boolean)
        });

        // Unique-ID first so offerDecline removes all but that one
        this.signal('route', ['Unique-ID', 'Caller-Caller-ID-Number', 'variable_sip_call_id'].map(function (key, idx, arr) {
            return this[key];
        }, this.locals.alegEvt.headers));
        return worker.sessions[this.locals.sid] = this;
    },
    leave: function onSessionLeave() {
        var expire, locals = this.locals;
        console.log('onSessionLeave', locals.sid);
        while (locals.consumers.length)
            locals.consumers.pop().enter(null);
        if (locals.communicator) {
            locals.communicator = locals.communicator.enter(null);
            expire = { event: 'expire', sid: locals.sid };
            debug.enabled && debug('<?? worker:expire#' + worker.id, JSON.stringify(expire));
            worker.__proto__.send(expire, worker.handle, worker.sent('onSessionLeave'));
        }
        delete worker.sessions[locals.sid];
        for (var i in this.locals.routes)
            delete worker.routes[this.locals.routes[i]];

        main.control.retired && !Object.keys(worker.sessions).length && process.terminate();
    },
    route: function onSessionRoute(routes) {
        for (var i in routes) {
            if (worker.routes[routes[i]]) // already routed
                continue;
            this.locals.routes.push(routes[i]);
            worker.routes[routes[i]] = this;
        }
    },
    offerOutcome: function onSessionOfferOutcome(accepted) { // Boolean
        console.log('onSessionOfferOutcome:', accepted ? 'accepted' : 'declined');
        if (!accepted) // discard session
            return this.enter(null);
        if (this.locals.communicator) // already accepted
            return;
        
        var Communicator = this.locals.alegEvt && main.config.Communicators[this.locals.alegEvt.headers['Caller-Destination-Number']];
        this.locals.communicator = Communicator ? new Communicator(this) : this.enter(null);
    },
    jsonReceived: function onSessionJsonReceived(json) { // { ?nowip, ?scaip } - always after offerOutcome-accepted
        var forwarded = this.locals.communicator.signal('jsonReceived', json);
        forwarded || console.log('onSessionJsonReceived:');
        return forwarded && this; // confirms that signal('jsonReceived', json) has been consumed
    },
    consume: function onSessionConsume() {
        console.log('onSessionConsume:');
        var consumers = this.locals.consumers;
        consumers.length || consumers.push(new main.modules.ConsumerNowipVolt(this, this.locals.fallbackUris));
        while (true) {
            if (isNaN(consumers.index)) // first consumer
                consumers.index = 0;
            else // next consumer
                ++consumers.index;
            consumers.index %= consumers.length;
            if (consumers.index > 0) // proceed with next consumer
                null;
            else if (consumers.tries < 1) // wrapped-around and out-of-tries
                return this.enter(null) || this;
            else // wrapped-around so begin a retry
                --consumers.tries;
            if (consumers[consumers.index].signal('activate'))
                break;
        }
    },
    // CHANNEL_CREATE is handled by StateMachine instantiation
    CHANNEL_: function onSessionChannel(evt, aleg) { // catchall for CHANNEL_PROGRESS, CHANNEL_PROGRESS_MEDIA, CHANNEL_ANSWER
        if (aleg && !this.locals.communicator) { // we have no communicator, so offer not yet accepted
            console.log('onSessionChannel:', evt.type);
            return (this.locals.alegEvt = evt) && this;
        }
        var target = aleg ? this.locals.communicator : this.locals.consumers[this.locals.consumers.index];
        var forwarded = target && target.signal('CHANNEL_', evt, aleg) && this;
        forwarded || console.log('onSessionChannel:', aleg ? 'aleg' : 'bleg', evt.type, evt);
        //console.log('onSessionChannel:', aleg?'aleg':'bleg', { to_user: evt.headers.variable_sip_to_user, from_user: evt.headers.variable_sip_from_user, type: evt.type, target: !!target })
        return forwarded || this.enter(null) || this;
    },
    CHANNEL_DESTROY: function onSessionChannelDestory(evt, aleg) {
        var target = aleg ? this.locals.communicator : this.locals.consumers[this.locals.consumers.index];
        var forwarded = target && target.signal(evt.type, evt, aleg) && this;
        forwarded || console.log('onSessionChannelDestory:', aleg ? 'aleg' : 'bleg', evt.type, evt);
        //console.log('onSessionChannelDestory:', aleg?'aleg':'bleg', { to_user: evt.headers.variable_sip_to_user, from_user: evt.headers.variable_sip_from_user, type: evt.type, target: !!target })
        return forwarded || this.enter(null) || this;
    },
    MESSAGE: function onSessionMessage(evt, aleg) { // { headers, hPtr, type, subclass, body }, '[from_user|to_user]'
        if (aleg && !this.locals.communicator) // we have no communicator, so offer not yet accepted
            return (this.locals.alegMsg = evt) && this;
        var target = aleg ? this.locals.communicator : this.locals.consumers[this.locals.consumers.index];
        var forwarded = target && target.signal(evt.type, evt, aleg) && this;
        forwarded || console.log('onSessionMessage:', aleg ? 'aleg' : 'bleg', evt.type, evt);
        //console.log('onSessionMessage:', aleg?'aleg':'bleg', { to_user: evt.headers.to_user, from_user: evt.headers.from_user, type: evt.type, target: !!target })
        return forwarded || this;
    },
};
