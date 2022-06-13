var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    debug = require('debug')('session'),
    main = require.main.exports,
    mysql = require('../mysql'),
    os = require('os'),
    request = require('request'),
    rpscb = require('../rpscb'),
    worker = require('./worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Session, require('../state-machine'));
function Session(evt, communicatorName, arg) { // minimal evt is { headers: { 'Caller-Caller-ID-Number', variable_sip_call_id } }
    if (this instanceof Session === false)
        throw new Error('Constructor Session requires \'new\'');

    var origin = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'] || evt.headers['from_user'],
        service = evt.headers['variable_sip_req_user'] || evt.headers['to_user'],
        unique = main.uuidv1();
    Object.assign(this, {
        adverts: {}, // collection of rpscb channel=>callback subscriptions for end-session cleanup
        cid: {}, // {hex, dec} cds-call-id
        communicator: undefined, // presence of a Communicator indicates we are responsible for this alarm call
        consumers: Object.defineProperties(Object.assign([], { index: NaN, tries: 1 }), { index: { enumerable: false }, tries: { enumerable: false } }),
        context: {}, // svc/srv/from(e164|cid)/host/user/param/truncate - database lookup
        detached: false,
        evoId: unique, // used for sip_invite_call_id on consumer-leg
        firstEvt: evt, // CHANNEL_CREATE or MESSAGE
        keepalived: undefined, // timestamp of latest successful communicator transaction
        leaving: 0,
        payload: { // { service, ?ATM:{version,type,data,time,mac} }, ?mrq:{ref,cid,dty,...} } - NOWIP/SCAIP payload
            protocol: undefined, // set once known
            // service
            //  session - CHANNEL.headers['variable_sip_req_user']
            //  session - MESSAGE.headers['to_user']
            // originUser
            //  communicator-assist - CHANNEL.headers['Caller-Caller-ID-Number']
            //  communicator-detect:bs8521 - ATM:data:controllerunit without leading zeros
            //  communicator-detect:tt92 - identity without trailing stars
            //  communicator-detect:ttnew - identify without trailing stars
            //  communicator-nowip - CHANNEL.headers['Caller-Caller-ID-Number']
            //  communicator-scaip - MESSAGE.headers['from_user']
            // e164
            //  communicator-bs8521-pnc - CHANNEL.headers['Caller-Caller-ID-Number'] without leading '+'
            //  communicator-detect - CHANNEL.headers['Caller-Caller-ID-Number'] without leading '+'
            //  communicator-scaip - CHANNEL.headers['Caller-Caller-ID-Number'] without leading '+'
            // ATM
            //  communicator-detect:bs8521 - { data: <received DTMF> }
            //  communicator-nowip - MESSAGE parsed XML { version, type, data, time, mac, ?wgs }
            //  transform:mrq2atm - contrusted DATA string
            //  transform:tt2atm - constructed DATA string
            // atm
            //  transform:mrq2atm - merged atm-JSON
            // bs8521
            //  communicator-detect:bs8521 - parsed NOWIP data
            // mrq
            //  communicator-scaip - MESSAGE parsed XML { ref, cid, dty, ... }
            // mrs
            //  communicator-scaip - MESSAGE prepared XML { ref, snu, ... }
            // bsia
        },
        origin: origin, // call-from-user OR mesg-caller-id
        sid: '$' + origin + '$' + unique,
        started: new Date,
        tags: [], // for cleanup when finished
        training: undefined,
        transactingMs: 0,
        unique: unique,
    }, evt.scaber); // evt.scaber updates origin/unique/sid when available (see worker:onWorkerEslMessage)
    Session.super_.call(this, Session, undefined, evt); // attach enter+signal methods and enter initial state
    this.communicator = new main.config.Communicators[communicatorName](this, evt, arg);
    Object.defineProperties(this, { // protect certain attributes from being updated
        adverts: { writable: false },
        communicator: { writable: false },
        consumers: { writable: false },
        evoId: { writable: false },
        firstEvt: { writable: false, enumerable: false },
        origin: { writable: false }, // used by worker:CHANNEL_CREATE when training
        sid: { writable: false },
        started: { writable: false },
        unique: { writable: false },
    });
}
Object.assign(Session, { // _this_ of all methods is the StateMachine instance
    adviseMap: {
    'catalogue': '', // prevent this command
    'command.choose': '', // prevent this command
    'command.clear': '', // prevent this command
    'command.connect': '', // prevent this command
    'command.duplex': '', // prevent this command
    'command.listen': '', // prevent this command
    'command.simplex': '', // prevent this command
    'command.speak': '', // prevent this command
    'control.exit': '', // prevent this command
    'paramGet': '', // prevent this command
    'paramSet': '', // prevent this command
    'quick.close': '', // prevent this command
    },
    graceMs: 10000, // keepalived delay for a transaction to run

    enter: function onSessionEnter(evt) { // TODO: vary action based on firstEvt.type [CHANNEL_CREATE|MESSAGE]
        debug(this.sid, 'enter:', evt.type, new Date);
        worker.sessions[this.sid] = this;
        this.signal('advertise', 'bridge:evoid:' + this.evoId);
    },
    leave: function onSessionLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.sid, 'leave:', JSON.stringify(this.tags));
        for (var channel in this.adverts)
            rpscb.removeListener(channel, this.adverts[channel]);
        for (var i in this.consumers)
            this.consumers[i].enter(null);
        this.communicator && this.communicator.enter(null);
        delete worker.sessions[this.sid];
        for (var i in this.tags)
            delete worker.tags[this.tags[i]];
        this.context.oystaBase && oystaReport(this, 'closed');
        process.emit('sessionDone', this);

        process.nextTick(process.emit.bind(process, 'writeCallData', this));
        if (Array.isArray(this.payload.bsia)) // bsia parent call
            process.nextTick(process.emit.bind(process, 'bsiaSpawnCalls', this.payload.bsia, this.communicator));
    },
    advertise: function (channel) { // advertise to rpscb
        if (channel in this.adverts) // prevent multiple registrations for the same channel
            return;

        rpscb.on(channel, this.adverts[channel] = this.signal.bind(this, 'advise', channel));
    },
    advise: function onSessionAdvise(channel, command /*, ..., cb */) { // rpscb-to-communicator transaction
        debug.enabled && debug(this.sid, 'advise:', channel, argsMap(arguments).slice(1));
        var adviseCb,
            args = Array.from(arguments), // rpscb('bridge:evoid:<evoid>', 'quick.speak', cb)
            cb = typeof args[args.length - 1] === 'function' && args.pop(),
            keepalived = this.keepalived; // saved for restore on failure

        if (Date.now() - this.transactingMs < exports.graceMs) // protect any ongoing transaction for upto graceMs (usually 10000)
            return cb && cb(null, '-BUSY');
        else
            this.transactingMs = Date.now();

        if (command in exports.adviseMap)
            command = exports.adviseMap[command];
        var cmds = command.split('.'); // e.g. quick.speak => ['quick', 'speak']
        if (cmds[0] in exports.adviseMap)
            cmds[0] = exports.adviseMap[cmds[0]];

        args.push(adviseCb = function onSessionAdviseCb(/* err, outcome, ... */) {
            var args = arguments,
                consumer = this.consumers[this.consumers.index];
            if (command === 'command.close' && (consumer ? consumer.signal('cleanup') : this.signal('consume', true)))
                args = [null, '+SUCCESS'];

            debug.enabled && debug(this.sid, 'adviseCb:', argsMap(args));
            this.keepalived = (args[1] || '').startsWith('+')
                ? new Date // update timestamp for keepalive timing
                : keepalived; // restore saved timestamp on failure for keepalive timing
            this.transactingMs = 0;
            cb && cb.apply(this, args);
        }.bind(this));

        this.keepalived = new Date(Date.now() + exports.graceMs); // give ourselved breathing space for this transaction
        var communicator = this.communicator, consumer = this.consumers[this.consumers.index];
        if (cmds[0] === 'consumer') {
            this.keepalived = keepalived; // remove keepalive graceMs as consumer transaction doesn't need protection and need unadulterated timestamp
            if (!consumer || !consumer.signal.apply(consumer, ['transaction', cmds[0], cmds[1]].concat(args.slice(2))))
                adviseCb(null, '-UNAVAILABLE');
            this.keepalived = keepalived; // restore keepalived timestamp as consumer transaction is not counted
        } else if (!communicator.signal.apply(communicator, ['transaction', cmds[0], {}, cmds[1]].concat(args.slice(2)))) // {} instead of [] indicates outcome indication required
            adviseCb(null, '-UNAVAILABLE');
    },
    tag: function onSessionTag(tags) {
        debug.enabled && debug(this.sid, 'tag:', JSON.stringify(tags), callsites()[2].toString());
        var first = !this.tags.length;
        for (var i in tags) {
            if (!tags[i] || worker.tags[tags[i]]) // non-tag OR already tagged
                continue;
            worker.tags[tags[i]] = this;
            this.tags.push(tags[i]); // for _leave_ cleanup
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
        //this.communicator.signal('answer'); // unnecessary as done automatically by the freeswitch-bridge
    },
    detach: function onSessionDetach() { // consume-done, consume-failed
        debug(this.sid, 'detach:');
        if (this.detached)
            return this;

        return this.communicator.signal('clear') || this.communicator.enter(null) || this;
    },
    detached: function onSessionDetached() { // Communicator.leave
        debug.enabled && debug(this.sid, 'detached:', callsites()[2].toString());
        this.detached = true;
        this.consumers.forEach(function (consumer, idx, arr) {
            consumer.enter(null);
        });
        return this.enter(null) || this;
    },
    route: function onSessionRoute() {
        debug.enabled && debug(this.sid, 'route:', callsites()[2].toString());
        var cb = this.signal.bind(this, 'consume');
        return process.emit('routingLookup', this, function (err) {
            err && console.log('onSessionRoute:', err);
            cb();
        }) || cb() || this;
    },
    consume: function onSessionConsume(conclusion) { // undefined=communicator-start; false=consumer-failed; true=consumer-bridged
        debug.enabled && debug(this.sid, 'consume:', JSON.stringify(conclusion), this.detached ? 'detached' : 'attached', callsites()[2].toString());
        if (this.detached) // Communicator been & gone
            return this.enter(null) || this;

        if (typeof conclusion !== 'boolean') // communicator-start
            Object.assign(this.consumers, { index: NaN, tries: 1 });
        else if (conclusion === true) // consumer-bridged
            return this.signal('detach') || this;

        if (!Array.isArray(this.context.consumers)) // ensure we have an array of Consumers
            this.context.consumers = [];
        if (!this.context.consumers.length && (this.context.callCode || {}).sbr_routingaddress) // only an SBR supplied a routingAddress
            this.context.consumers.push(this.context.callCode.sbr_routingaddress); // e.g. simple,+441452922908@fs1.appello.cloud.byoc.euw2.pure.cloud

        var consumers = this.consumers,
            split,
            Consumer;
        if (consumers.length) { // already have a list of prepared Consumers
            null;
        } else if (this.context.bridge) { // prepare consumer-bridge
            consumers.push(new main.config.Consumers.bridge(this, this.context.bridge));
        } else if ((conclusion || {}).constructor.name === 'SlsUser') { // prepare consumer-slsuser
            consumers.push(new main.config.Consumers.slsUser(this));
        } else if (!Array.isArray(consumers)) { // invalid consumer list
            null;
        } else for (var c in this.context.consumers) { // array of '<consumer>,<uri>,<uri>,...'
            if (typeof this.context.consumers[c] !== 'string')
                continue;
            split = this.context.consumers[c].split(/,+/);
            if (Consumer = main.config.Consumers[split[0]])
                consumers.push(new Consumer(this, split.slice(1).join()));
        }

        if (!consumers.length || this.context.truncate) // no-consumers OR autoAnswer
            return this.signal('detach') || this;

        while (true) {
            if (isNaN(consumers.index)) // first Consumer
                consumers.index = 0;
            else // next consumer
                ++consumers.index;
            if (consumers.index >= consumers.length) // wrap-around decrementing tries
                consumers.index = --consumers.tries && 0;
            if (!consumers[consumers.index] || consumers.tries < 1) // no-consumer OR out-of-tries
                return this.signal('detach') || this;

            if (consumers[consumers.index].signal('activate', conclusion)) // returns falsy on activate failure
                break;
        }
    },
    contextRelease: function onSessionContextRelease(context) { // ConsumerDetect:Protocols.timeout
        debug.enabled && debug(this.sid, 'contextRelease:', JSON.stringify(context));
        if (!this.payload.e164)
            return this.communicator.signal('release');

        var nameSlashed = '/scaber/from/+' + this.payload.e164 + '/context';
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.sid, 'onSessionContextRelease:', err);

        }, function () {
            this.index = sm.sid;
            mysql('select * from config where nameSlashed=? and schemeId=0', [nameSlashed], this);

        }, function (configs, meta) {
            mysql(mysql.mksql('config', { nameSlashed: nameSlashed, valueNumber: 50, valueString: JSON.stringify(context) }, configs[0]), this);

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
            sm.communicator.signal('release') || sm.enter(null);

        });
        // context:
        //  truncate: aka autoAnswer
        //  detect: list of Protocols to detect e.g. 'Guard,Bsia' (see CommunicatorDetect:Protocols for list)
        //  notraining: boolean to prevent SCAIP-CLI training
        //  bridge: bridge forwarding +e164 dial-string e.g. 'gateway/magrathea/+442030366946'
        //  consumers: ['consumer,uri,uri,...'] OR null means use SBR routing
        //  lhdigits: 'digits to override the leading digits of the 12 digit controllerunit'
        //  paid: P-Asserted-Identity for bridged outbound calls
        //  ---
        //  guardMs: initial guard delay
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
        //  bsia: number of protocol proke attempts
        //  ---
        //  ttold: number of protocol provoke attempts
        //  ttoldAny: bridge dial-string to configure for any TTOld Communicator
        //  ttoldGrp: bridge dial-string to configure for any TTOld Grouped Communicator
        //  ttoldTvs: bridge dial-string to configure if Communicator has no HVS support
        //  ---
        //  unknown: bridge dial-string to configure if Communicator is unrecognised
        //  NOTE - assigning _null_ to any context attribute in a higher priority row will eliminated that attribute is the final merge
    },
    communicator: function onSessionCommunicator(type, match, subtype /* , ..., ?cb */) { // consumer-to-communicator transaction
        debug.enabled && debug(this.sid, 'communicator:', argsMap(arguments));
        var args = Array.from(arguments),
            cb = (typeof args[args.length - 1] === 'function') && args.pop(),
            communicatorCb,
            keepalived = this.keepalived; // saved for restore on failure

        if (Date.now() - this.transactingMs < exports.graceMs) // protect any ongoing transaction for upto graceMs (usually 10000)
            return Array.isArray(match) ? cb && cb(null, '') : cb && cb(null, '-BUSY');
        else
            this.transactingMs = Date.now();

        this.keepalived = new Date(Date.now() + exports.graceMs); // give ourself breathing space for this transaction
        args.push(communicatorCb = function onSessionCommunicatorCb(err) {
            debug.enabled && debug(this.sid, 'communicatorCb:', argsMap(arguments));
            this.keepalived = (Array.isArray(match) ? arguments[1] !== '' : (arguments[1] || '').startsWith('+'))// successful transaction
                ? new Date // update timestamp for keepalive timing
                : keepalived; // restore saved timestamp on failure for keepalive timing
            this.transactingMs = 0;
            cb ? cb.apply(this, arguments) : err && console.log(this.sid, 'onSessionCommunicatorCb:', err);
        }.bind(this));

        var communicator = this.communicator;
        if (!communicator || !communicator.signal.apply(communicator, ['transaction'].concat(args)))
            communicatorCb(null, Array.isArray(match) ? '' : '-UNAVAILABLE');
    },
    //consumer: function onSessionConsumer(signal, type, match, /* , ..., ?cb */) { // communicator-to-consumer transaction
    //    var args = Array.from(arguments),
    //        cb = (typeof args[args.length - 1] === 'function') && args.pop();
    //    args.push(function onSessionConsumerCb(err) {
    //        cb ? cb.apply(this, arguments) : err && console.log(this.sid, 'onSessionConsumerCb:', err);
    //    }.bind(this));
    //    var consumer = this.consumers[consumers.index];
    //    (!consumer || !consumer.signal.apply(consumer, ['transaction'].concat(args))) && cb && cb(null, '');
    //},
    CHANNEL_CREATE: function onSessionChannelCreate(evt, first) { // worker.onWorkerEslChannel
        var forwarded,
            hex = evt.headers['variable_sip_h_X-CDS-CallId'],
            cid = '',
            sid = this.sid, communicatorName;
        if (hex && this.cid.hex !== hex) {
            this.cid.hex = hex;
            this.cid.dec = hex.match(/.{1,8}/g).map(x => parseInt(x, 16)).join('-');
            this.signal('advertise', 'bridge:cdsid:' + this.cid.dec);
            cid = '#### ' + this.cid.dec + ' H(' + hex + ')';
        }
        this.signal('tag', [evt.headers['Unique-ID']]);
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

            //if (first && !sm.detached) // Communicator may have been detached by Communicator CHANNEL_CREATE handler
            //    worker.sessions[sm.sid] = sm;

        }, function () {
            if (sm.payload.service) // already done the configJson call for this session
                return this();

            var user = evt.headers['Caller-Caller-ID-Number'] || '',
                n = Math.max(0, user.length - 2); // Math.min(5, user.length);
            sm.payload.service = evt.headers['variable_sip_req_user'];
            var contexts = [
                '/scaber/default/context',
                '/scaber/' + (evt.headers['variable_sofia_profile_name'].startsWith('ext') ? 'anonymous' : 'authorised') + '/context',
                '/scaber/svc/' + sm.payload.service + '/context',
                '/scaber/svr/' + os.hostname() + '/context',
                '/scaber/svc/' + sm.payload.service + '/svr/' + os.hostname() + '/context',
            ];

            while (n--)
                contexts.push('/scaber/from/' + user.slice(0, user.length - n) + 'x'.repeat(n) + '/context');

            (evt.headers['variable_sip_req_params'] || '').split(/;+/).forEach(function (nvp, idx, arr) {
                if (!nvp || !(nvp = nvp.match(/^([^=]+)=(.*)/)))
                    return;

                this.push('/scaber/param:' + nvp[1] + '/' + nvp[2] + '/context');
                this.push('/scaber/param:' + nvp[1] + '/' + nvp[2] + '/from/' + user.slice(0, 4) + '/context');
                var cli;
                if (cli = nvp[2].match(/:cli(\d+)/))
                    this.push('/scaber/param:' + nvp[1] + '/' + nvp[2] + '/from/' + user.slice(0, +cli[1]) + '/context');
                if (nvp[1] === 'ds') // data-source
                    sm.payload.dataSource = nvp[2];
            }, contexts);

            evt.headers['variable_sip_req_host'] && contexts.push('/scaber/host/' + evt.headers['variable_sip_req_host'] + '/context');

            worker.configJson(contexts, sm.context, Object.assign(this, { index: sm.sid }));
            // context: see Session.contextRelease

        });

        return this; // indicate as handled
    },
    CHANNEL_: function onSessionChannel(evt, first) { // worker.onWorkerEslChannel - catchall for CHANNEL_PROGRESS, CHANNEL_PROGRESS_MEDIA, CHANNEL_ANSWER
        var forwarded,
            hex = evt.headers['variable_sip_rh_X-CDS-CallId'],
            cid = '';
        if (hex && this.cid.hex !== hex) {
            this.cid.hex = hex;
            this.cid.dec = hex.match(/.{1,8}/g).map(x => parseInt(x, 16)).join('-');
            this.signal('advertise', 'bridge:cdsid:' + this.cid.dec);
            cid = '#### ' + this.cid.dec + ' H(' + hex + ')';
        }
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Consumer', cid);
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal('CHANNEL_', evt);
            forwarded || console.log(this.sid, 'onSessionChannel:', 'Consumer', JSON.stringify(evt)) || this.enter(null);
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, evt.type + ':', evt.headers['Unique-ID'], 'Communicator', cid);
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
        var forwarded,
            sid = this.sid,
            direction = evt.headers['Call-Direction'] || (evt.headers['to_user'] === this.payload.originUser ? 'outbound' : 'inbound');
        if (direction === 'outbound') {
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

            if (first && !sm.detached) // Communicator may have been discarded by Communicator MESSAGE handler
                worker.sessions[sm.sid] = sm;

        }, function () {
            if (sm.payload.service) // already done the configJson call for this session
                return this();

            sm.payload.service = evt.headers['to_user'];
            var contexts = [
                '/scaber/default/context',
                '/scaber/' + (evt.headers['sip_profile'].startsWith('ext') ? 'anonymous' : 'authorised') + '/context',
                '/scaber/svc/' + sm.payload.service + '/context',
                '/scaber/svr/' + os.hostname() + '/context',
                '/scaber/svc/' + sm.payload.service + '/svr/' + os.hostname() + '/context',
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
    RECV_INFO: function onSessionInfo(evt, first) {
        if (evt.headers['Call-Direction'] === 'outbound') { // Consumer
            debug(this.sid, 'INFO:', evt.headers['Unique-ID'], 'Consumer');
            forwarded = this.consumers[this.consumers.index] && this.consumers[this.consumers.index].signal(evt.type, evt, first);
            !forwarded && evt.body && console.log(this.sid, 'onSessionInfo:', 'Consumer', JSON.stringify(evt));
            return this; // indicate as handled
        }

        // Communicator
        debug(this.sid, 'INFO:', evt.headers['Unique-ID'], 'Communicator');
        forwarded = this.communicator && this.communicator.signal(evt.type, evt, first);
        !forwarded && evt.body && console.log(this.sid, 'onSessionDtmf:', 'Communicator', JSON.stringify(evt));
        return this; // indicate as handled
    },
});

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
    debug.enabled && debug(session.sid, 'oystaReport:', JSON.stringify(oysta));
    request(oysta, function (err, resp, json) {
        Object.assign(oysta, { err: err, resp: resp, json: json });
        if (err)
            return console.log(session.sid, 'oystaReport:', err);

        debug.enabled && debug(session.sid, 'oystaReport:', JSON.stringify({ statusCode: resp.statusCode, statusMessage: resp.statusMessage, body: resp.body }));
    });

}
