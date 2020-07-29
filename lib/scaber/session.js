var argsMap = require('../args-map');
var debug = require('debug')('session');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = Session;

require('util').inherits(Session, require('../state-machine'));
function Session(evt, communicatorName) { // minimal evt is { headers: { 'Caller-Caller-ID-Number', variable_sip_call_id } }
    if (this instanceof Session === false)
        throw new Error('Constructor Session requires \'new\'');
    var origin = evt.headers['Caller-Caller-ID-Number'] || evt.headers['from_user'];
    var unique = evt.headers['variable_sip_call_id'] || main.uuidv1();
    Object.assign(this, {
        communicator: undefined, // presence of a Communicator indicates we are responsible for this alarm call
        consumers: Object.assign([], { index: NaN, tries: 1 }),
        detached: false,
        established: false, // set TRUE by Worker after 1st transaction completes
        fallbackUris: undefined,
        firstEvt: evt, // CHANNEL_CREATE or MESSAGE
        leaving: 0,
        payload: {}, // { ?ATM:{version,type,data,time,mac} }, ?mrq:{ref,cid,dty,...} } - NOWIP/SCAIP payload
        origin: origin, // call-from-user OR mesg-caller-id
        routes: [], // for cleanup when finished
        sid: '$' + origin + '$' + unique,
        started: new Date,
        tasks: [],
        unique: unique,
    });
    Session.super_.call(this, sessionState, undefined, evt);
    this.communicator = new main.config.Communicators[communicatorName](this, evt);
    Object.defineProperties(this, { // protect certain attributes from being updated
        communicator: { writable: false },
        consumers: { writable: false },
        firstEvt: { writable: false, enumerable: false },
        started: { writable: false },
        tasks: { writable: false, enumerable: false },
    });
}

var sessionState = {// _this_ of all methods is the StateMachine instance
    enter: function onSessionEnter(evt) { // TODO: vary action based on firstEvt.type [CHANNEL_CREATE|MESSAGE]
        debug(this.sid, 'enter:', evt.type, new Date);
    },
    leave: function onSessionLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug.enabled && debug(this.sid, 'leave:', JSON.stringify(this.routes));
        while (this.consumers.length)
            this.consumers.pop().enter(null);
        this.communicator && this.communicator.enter(null);
        delete worker.sessions[this.sid];
        for (var i in this.routes)
            delete worker.routes[this.routes[i]];
        process.emit('sessionDone', this);
    },
    route: function onSessionRoute(routes) {
        debug.enabled && debug(this.sid, 'route:', JSON.stringify(routes));
        for (var i in routes) {
            if (!routes[i] || worker.routes[routes[i]]) // non-route OR already routed
                continue;
            worker.routes[routes[i]] = this;
            this.routes.push(routes[i]); // for _leave_ cleanup
        }
    },
    json: function onSessionJson(json) { // { ?nowip, ?scaip } - always after offerOutcome-accepted
        debug(this.sid, 'json:');
        var forwarded = this.communicator && this.communicator.signal('json', json);
        forwarded || console.log(this.sid, 'onSessionJson:', JSON.stringify(json));
        return forwarded && this; // confirms that signal has been consumed
    },
    answer: function onSessionAnswer() {
        debug(this.sid, 'answer:');
        this.communicator.signal('answer');
    },
    detach: function onSessionDetach() {
        debug(this.sid, 'detach:');
        this.detach || this.communicator.signal('clear');
    },
    detached: function onSessionDetached() { // communicator finished
        debug(this.sid, 'detached:');
        this.detached = true;
        return this.consumers.length
            ? this.consumers[this.consumers.index].signal('cleanup')
            : this.enter(null);
    },
    consume: function onSessionConsume(bridged) { // undefined:start; false: consumer-failed; true: consumer-bridged
        debug(this.sid, 'consume:', ({ undefined: 'start', false: 'failed', true: 'bridged' })[bridged], this.detached ? 'detached' : 'attached');
        if (this.detached)
            return this.enter(null) || this;
        if (bridged)
            return this.signal('detach') || this;
        var consumers = this.consumers;
        consumers.length || consumers.push(new main.modules.ConsumerNowipVolt(this, process.env.FALLBACKURIS || this.fallbackUris));
        while (true) {
            if (isNaN(consumers.index)) // first consumer
                consumers.index = 0;
            else // next consumer
                ++consumers.index;
            consumers.index %= consumers.length;
            if (consumers.index > 0) // proceed with next consumer
                null;
            else if (consumers.tries < 1) // wrapped-around and out-of-tries
                return this.signal('detach') || this;
            else // wrapped-around so begin a retry
                --consumers.tries;
            if (consumers[consumers.index].signal('activate')) // returns falsy on activate failure
                break;
        }
    },
    CHANNEL_CREATE: function onSessionChannelCreate(evt, first) { // called by _enter_
        var forwarded, sid = this.sid;
        if (evt.headers['variable_appello_unique'] === this.unique) { // Consumer
            debug(this.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionChannelCreate:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID'], 'Communicator');
        if (!this.communicator && worker.isCommunicatorUser(evt.headers['Caller-Destination-Number']))
            this.communicator = new main.config.Communicators[evt.headers['Caller-Destination-Number']](this, evt);

        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        forwarded || console.log(this.sid, 'onSessionChannelCreate:', 'Communicator', JSON.stringify(evt));
        this.sid === sid || debug(this.sid, 'renamed: from', sid);

        if (first && !this.detached) { // communicator may have been detached by communicator CHANNEL_CREATE handler
            this.signal('route', [evt.headers['Caller-Caller-ID-Number'], this.unique]); // caller-number(A), sip-call-id(B)
            worker.sessions[this.sid] = this;
        }
        this.signal('route', [evt.headers['Unique-ID']]); // caller-uuid(A)
        return this; // indicate as handled
    },
    CHANNEL_: function onSessionChannel(evt, first) { // catchall for CHANNEL_PROGRESS, CHANNEL_PROGRESS_MEDIA, CHANNEL_ANSWER
        var forwarded;
        if (evt.headers['variable_appello_unique'] === this.unique) { // Consumer
            debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal('CHANNEL_', evt);
            forwarded || console.log(this.sid, 'onSessionChannel:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && this.communicator.signal('CHANNEL_', evt, first);
        forwarded || console.log(this.sid, 'onSessionChannel:', 'Communicator', JSON.stringify(evt)) || this.enter(null);
        return this; // indicate as handled
    },
    CHANNEL_DESTROY: function onSessionChannelDestory(evt, first) {
        var forwarded;
        if (evt.headers['variable_appello_unique'] === this.unique) { // Consumer
            debug(this.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionChannelDestroy:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        forwarded || console.log(this.sid, 'onSessionChannelDestroy:', 'Communicator', JSON.stringify(evt)) || this.enter(null);
        return this; // indicate as handled
    },
    MESSAGE: function onSessionMessage(evt, first) { // { headers, hPtr, type, subclass, body }, boolean
        var forwarded, sid = this.sid;
        if (evt.headers['to_user'] === this.origin) {
            debug(this.sid, 'MESSAGE:', 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionMessage:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'MESSAGE:', 'Communicator');
        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        forwarded || console.log(this.sid, 'onSessionMessage:', 'Communicator', JSON.stringify(evt)) || this.enter(null);

        if (first && !this.detached) { // communicator may have been discarded by communicator MESSAGE handler
            this.signal('route', [evt.headers['from_user'], this.origin, this.unique]); // caller-number(A), caller-id(A), appello-unique(B)
            worker.sessions[this.sid] = this;
        }
        return this; // indicate as handled
    },
};
