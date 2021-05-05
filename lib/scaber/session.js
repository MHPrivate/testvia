var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var debug = require('debug')('session');
var main = require.main.exports;
var mysql = require('../mysql');
var os = require('os');
var request = require('request');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = Session;

require('util').inherits(Session, require('../state-machine'));
function Session(evt, communicatorName, arg) { // minimal evt is { headers: { 'Caller-Caller-ID-Number', variable_sip_call_id } }
    if (this instanceof Session === false)
        throw new Error('Constructor Session requires \'new\'');

    var origin = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'] || evt.headers['from_user'];
    var service = evt.headers['variable_sip_req_user'] || evt.headers['to_user'];
    var unique = main.uuidv1();
    Object.assign(this, {
        communicator: undefined, // presence of a Communicator indicates we are responsible for this alarm call
        consumers: Object.defineProperties(Object.assign([], { index: NaN, tries: 1 }), { index: { enumerable: false }, tries: { enumerable: false } }),
        context: {}, // svc/srv/from(e164|cid)/host/user/param - database lookup
        detached: false,
        fallbackUris: undefined,
        firstEvt: evt, // CHANNEL_CREATE or MESSAGE
        leaving: 0,
        payload: {}, // { service, ?ATM:{version,type,data,time,mac} }, ?mrq:{ref,cid,dty,...} } - NOWIP/SCAIP payload
        origin: origin, // call-from-user OR mesg-caller-id
        routes: [], // for cleanup when finished
        sid: '$' + origin + '$' + unique,
        started: new Date,
        tasks: [],
        training: undefined,
        unique: unique,
    }, evt.scaber); // evt.scaber updates origin/unique/sid when available (see worker:onWorkerEslMessage)
    Session.super_.call(this, sessionState, undefined, evt);
    this.communicator = new main.config.Communicators[communicatorName](this, evt, arg);
    Object.defineProperties(this, { // protect certain attributes from being updated
        communicator: { writable: false },
        consumers: { writable: false },
        firstEvt: { writable: false, enumerable: false },
        origin: { writable: false }, // used by worker:CHANNEL_CREATE when training
        sid: { writable: false },
        started: { writable: false },
        tasks: { writable: false, enumerable: false },
        unique: { writable: false },
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
        for (var i in this.consumers)
            this.consumers[i].enter(null);
        this.communicator && this.communicator.enter(null);
        delete worker.sessions[this.sid];
        for (var i in this.routes)
            delete worker.routes[this.routes[i]];
        this.context.oystaBase && oystaReport(this, 'closed');
        process.emit('sessionDone', this);
    },
    route: function onSessionRoute(routes) {
        debug.enabled && debug(this.sid, 'route:', JSON.stringify(routes), callsites()[2].toString());
        var first = !this.routes.length;
        for (var i in routes) {
            if (!routes[i] || worker.routes[routes[i]]) // non-route OR already routed
                continue;
            worker.routes[routes[i]] = this;
            this.routes.push(routes[i]); // for _leave_ cleanup
        }
        first && process.emit('sessionAnnc', this);
    },
    json: function onSessionJson(json) { // { ?nowip, ?scaip } - always after offerOutcome-accepted
        debug.enabled && debug(this.sid, 'json:', callsites()[2].toString());
        var forwarded = this.communicator && this.communicator.signal('json', json);
        forwarded || console.log(this.sid, 'onSessionJson:', JSON.stringify(json));
        return forwarded && this; // confirms that signal has been consumed
    },
    answer: function onSessionAnswer() { // Consumer-CHANNEL_ANSWER
        debug.enabled && debug(this.sid, 'answer:', callsites()[2].toString());
        this.context.oystaBase && oystaReport(this, 'inProgress');
        this.communicator.signal('answer');
    },
    detach: function onSessionDetach() { // consume-done, consume-failed
        debug.enabled && debug(this.sid, 'detach:');
        this.detach || this.communicator.signal('clear');
    },
    detached: function onSessionDetached() { // Communicator.leave
        debug.enabled && debug(this.sid, 'detached:', callsites()[2].toString());
        this.detached = true;
        this.consumers.forEach(function (consumer, idx, arr) {
            consumer.enter(null);
        });
        return this.enter(null);
    },
    consume: function onSessionConsume(conclusion) { // undefined=start; false=consumer-failed; true=consumer-bridged
        debug.enabled && debug(this.sid, 'consume:', JSON.stringify(conclusion), this.detached ? 'detached' : 'attached', callsites()[2].toString());
        if (this.detached) // Communicator been & gone
            return this.enter(null) || this;

        if (typeof conclusion !== 'boolean') // start OR 'consumer-command-string'
            Object.assign(this.consumers, { index: NaN, tries: 1 });
        else if (conclusion === true) // consumer-bridged
            return this.signal('detach') || this;

        var consumers = this.consumers, split, Consumer;
        if (consumers.length) { // already prepared list of consumers
            null;
        } else if (this.context.bridge) { // prepare consumer-bridge
            consumers.push(new main.config.Consumers.bridge(this, this.context.bridge));
        } else if ((conclusion || {}).constructor.name === 'SlsUser') { // prepare consumer-slsuser
            consumers.push(new main.config.Consumers.slsUser(this));
        } else if (process.env.FALLBACKURIS) { // debug option
            consumers.push(new main.config.Consumers.nowipVolt(this, process.env.FALLBACKURIS));
        } else if (!Array.isArray(this.context.consumers)) { // invalid consumer list
            null;
        } else for (var c in this.context.consumers) { // array of '<consumer>,<uri>,<uri>,...'
            if (typeof this.context.consumers[c] !== 'string')
                continue;
            split = this.context.consumers[c].split(/,+/);
            if (Consumer = main.config.Consumers[split[0]])
                consumers.push(new Consumer(this, split.slice(1).join()));
        }
        while (true) {
            if (isNaN(consumers.index)) // first Consumer
                consumers.index = 0;
            else // next consumer
                ++consumers.index;
            consumers.index %= consumers.length;
            if (consumers.index > 0) // proceed with next Consumer
                null;
            else if (consumers.tries < 1) // wrapped-around and out-of-tries
                return this.signal('detach') || this;
            else // wrapped-around so begin a retry
                --consumers.tries;
            if (consumers[consumers.index].signal('activate', conclusion)) // returns falsy on activate failure
                break;
        }
    },
    contextRelease: function onSessionContextRelease(context) { // ConsumerDetect:Protocols.timeout
        debug.enabled && debug(this.sid, 'contextRelease:', JSON.stringify(context));
        if (!this.payload.e164)
            return this.communicator.signal('release');

        var nameSlashed = '/scaber/from/+' + this.payload.e164 + '/context'
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.sid, 'onSessionContextRelease:', err);

        }, function () {
            this.index = sm.sid;
            mysql('select * from config where nameSlashed=? and schemeId=0', [nameSlashed], this);

        }, function (configs, meta) {
            mysql(mysql.mksql('config', { nameSlashed: nameSlashed, valueNumber: 50, valueString: JSON.stringify(context) }), configs[0], this);

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
            sm.communicator.signal('release') || sm.enter(null);

        });
        // context:
        //  notraining: boolean to prevent SCAIP-CLI training
        //  bridge: bridge forwarding +e164 dial-string e.g. 'gateway/magrathea/+442030366946'
        //  consumers: ['consumer,uri,uri,...']
        //  lhdigits: 'digits to override the leading digits of the 12 digit controllerunit'
        //  ---
        //  bs8521: number of protocol provoke attempts
        //  bs8521Any: bridge dial-string to configure for any BS8521 Communicator
        //  bs8521Grp: bridge dial-string to configure for any BS8521 Grouped Communicator
        //  ---
        //  tt92: number of protocol provoke attempts
        //  tt92NoStmf: disable STMF detection
        //  tt92Stmf: bridge dial-string to configure if STMF is detected
        //  tt92Any: bridge dial-string to configure for any TT92 Communicator
        //  tt92Grp: bridge dial-string to configure for any TT92 Grouped Communicator
        //  tt92Tvs: bridge dial-string to configure if Communicator has no HVS support
        //  ---
        //  ttnew: number of protocol provoke attempts
        //  ttnewAny: bridge dial-string to configure for any TTNew Communicator
        //  ttnewGrp: bridge dial-string to configure for any TTNew Grouped Communicator
        //  ttnewTvs: bridge dial-string to configure if Communicator has no HVS support
        //  ---
        //  unknown: bridge dial-string to configure if Communicator is unrecognised
   },
    CHANNEL_CREATE: function onSessionChannelCreate(evt, first) { // worker.onWorkerEslChannel
        var forwarded, sid = this.sid, communicatorName;
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionChannelCreate: Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID'], 'Communicator');
        if (!this.communicator && (communicatorName = worker.getCommunicatorName(evt.headers['Caller-Destination-Number'])))
            this.communicator = new main.config.Communicators[communicatorName](this, evt);

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.sid, 'onSessionChannelCreate: Communicator', err);
            debug.enabled && debug(sm.sid, 'context:', JSON.stringify(sm.context));
            forwarded = sm.communicator && sm.communicator.signal(evt.type, evt, first);
            forwarded || console.log(sm.sid, 'onSessionChannelCreate: Communicator', JSON.stringify(evt));
            sm.sid === sid || debug(sm.sid, 'renamed: from', sid);

            var routes = [evt.headers['Unique-ID']]; // to match Communicator channel events
            if (first && !sm.detached) { // Communicator may have been detached by Communicator CHANNEL_CREATE handler
                routes.push(
                    evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'], // to match Communicator leg by CLI
                    sm.unique                             // to match Consumer legs tagged with variable_appello_unique
                );
                worker.sessions[sm.sid] = sm;
            }
            sm.signal('route', routes);

        }, function () {
            if (sm.payload.service) // already done the configJson call for this session
                return this();

            var contexts = [
                '/scaber/default/context',
                '/scaber/' + (evt.headers['variable_sofia_profile_name'].startsWith('ext') ? 'anonymous' : 'authorised') + '/context',
                '/scaber/svc/' + (sm.payload.service = evt.headers['variable_sip_req_user']) + '/context',
                '/scaber/svr/' + os.hostname() + '/context',
                '/scaber/svc/' + (sm.payload.service = evt.headers['variable_sip_req_user']) + '/svr/' + os.hostname() + '/context',
            ];

            var user = evt.headers['Caller-Caller-ID-Number'] || '', n = Math.min(5, user.length);
            while (n--)
                contexts.push('/scaber/from/' + user.slice(0, user.length - n) + 'x'.repeat(n) + '/context');

            (evt.headers['variable_sip_req_params'] || '').split(/;+/).forEach(function (nvp, idx, arr) {
                if (nvp && (nvp = nvp.match(/^([^=]+)=(.*)/)))
                    this.push('/scaber/param:' + nvp[1] + '/' + nvp[2] + '/context');
            }, contexts);

            evt.headers['variable_sip_req_host'] && contexts.push('/scaber/host/' + evt.headers['variable_sip_req_host'] + '/context');

            worker.configJson(contexts, sm.context, Object.assign(this, { index: sm.sid }));
            // context: see Session.contextRelease

        });

        return this; // indicate as handled
    },
    CHANNEL_: function onSessionChannel(evt, first) { // worker.onWorkerEslChannel - catchall for CHANNEL_PROGRESS, CHANNEL_PROGRESS_MEDIA, CHANNEL_ANSWER
        var forwarded;
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal('CHANNEL_', evt);
            forwarded || console.log(this.sid, 'onSessionChannel:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && (this.communicator.signal(evt.type, evt, first) || this.communicator.signal('CHANNEL_', evt, first));
        forwarded || console.log(this.sid, 'onSessionChannel:', 'Communicator', JSON.stringify(evt)) || this.enter(null);
        return this; // indicate as handled
    },
    CHANNEL_DESTROY: function onSessionChannelDestory(evt, first) { // worker.onWorkerEslChannel
        var forwarded;
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
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
    CUSTOM: function onSessionCustom(evt, first) { // worker.onWorkerEslCustom
        var forwarded;
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, 'CUSTOM:', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionCustom:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'CUSTOM:', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        forwarded || console.log(this.sid, 'onSessionCustom:', 'Communicator', JSON.stringify(evt)) || this.enter(null);
        return this; // indicate as handled
    },
    DETECTED_TONE: function onSessionTone(evt, first) { // worker.onWorkerEslTone
        var forwarded;
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionTone:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        forwarded || console.log(this.sid, 'onSessionTone:', 'Communicator', JSON.stringify(evt)) || this.enter(null);
        return this; // indicate as handled
    },
    DTMF: function onSessionDtmf(evt, first) { // worker.onWorkerEslDtmf
        var forwarded;
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, 'DTMF:', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionDtmf:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'DTMF:', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        forwarded || console.log(this.sid, 'onSessionDtmf:', 'Communicator', JSON.stringify(evt)) || this.enter(null);
        return this; // indicate as handled
    },
    MESSAGE: function onSessionMessage(evt, first) { // worker.onWorkerEslMessage - { headers, hPtr, type, subclass, body }, boolean
        var forwarded, sid = this.sid;
        if (evt.headers['to_user'] === this.payload.originUser) {
            debug(this.sid, 'MESSAGE:', 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            forwarded || console.log(this.sid, 'onSessionMessage: Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'MESSAGE:', 'Communicator');
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.sid, 'onSessionMessage: Communicator', err);
            debug.enabled && debug(sm.sid, 'context:', JSON.stringify(sm.context));
            forwarded = sm.communicator && sm.communicator.signal(evt.type, evt, first);
            forwarded || console.log(sm.sid, 'onSessionMessage: Communicator', JSON.stringify(evt)) || sm.enter(null);
            sm.sid === sid || debug(sm.sid, 'renamed: from', sid);

            if (first && !sm.detached) { // Communicator may have been discarded by Communicator MESSAGE handler
                sm.signal('route', [
                    evt.headers['from_user'],   // to match Communicator leg by SCAIP-controller-id
                    //sm.origin,                // to match Communicator leg by NOWIP-CLI
                    sm.unique,                // to match Consumer legs tagged with variable_appello_unique
                ]); // caller-number(A), caller-id(A), appello-unique(B)
                worker.sessions[sm.sid] = sm;
            }

        }, function () {
            if (sm.payload.service) // already done the configJson call for this session
                return this();

            var contexts = [
                '/scaber/default/context',
                '/scaber/' + (evt.headers['sip_profile'].startsWith('ext') ? 'anonymous' : 'authorised') + '/context',
                '/scaber/svc/' + (sm.payload.service = evt.headers['to_user']) + '/context',
                '/scaber/svr/' + os.hostname() + '/context',
                '/scaber/svc/' + (sm.payload.service = evt.headers['to_user']) + '/svr/' + os.hostname() + '/context',
            ];
            if (evt.headers['from_user']) {
                contexts.push('/scaber/from/' + evt.headers['from_user'] + '/context');
                contexts.push('/scaber/svc/' + sm.payload.service + '/from/' + evt.headers['from_user'] + '/context');
            }
            evt.headers['to_host'] && contexts.push('/scaber/host/' + evt.headers['to_host'] + '/context');
            this.index = sm.sid;
            worker.configJson(contexts, sm.context, this);
            // context: see Session.contextRelease

        });
    },
};

function oystaReport(session, ocm) {
    if (!session.payload.ATM)
        return;

    var oysta = {
        method: 'PUT',
        baseUrl: session.context.oystaBase,
        url: '/api/public/handleEvent',
        json: {
            token: main.secrets.oysta.token,
            deviceId: session.origin,
            ref: session.unique,
            time: Math.floor(Date.now() / 1000),
            subject: 'Oysta SCAIP update',
            message: session.payload.ATM.data[0],
            handler: os.hostname(),
            ocm: ocm, // inProgress | closed
        }
    };
    !session.payload.oysta ? session.payload.oysta = [oysta] : session.payload.oysta.push(oysta);
    debug(session.sid, 'oystaReport:', JSON.stringify(oysta));
    request(oysta, function (err, resp, json) {
        Object.assign(oysta, { err: err, resp: resp, json: json });
        if (err)
            return console.log(session.sid, 'oystaReport:', err);

        debug(session.sid, 'oystaReport:', JSON.stringify({ statusCode: resp.statusCode, statusMessage: resp.statusMessage, body: resp.body }));
    });

}
