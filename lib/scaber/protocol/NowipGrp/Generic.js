var debug,
    esl = require('../../../esl'),
    nowip = require('../../../nowip'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Generic, require('../../../state-machine'));

function Generic(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:NowipGrp:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, 'Generic:', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        args: args,                 // arguments for Generic transaction e.g.
                                    //  [
                                    //      'catalogue',                - purpose of transaction
                                    //      [                           - array augmented with attributes
                                    //          <Empty item>,            - empty item (or CareNet raw digits-string)
                                    //          '0',                     - catalogue unit-string
                                    //          send: 'a10000#@80',      - freeswitch digit-string to send
                                    //          regex: /#A(\d{12})#/g    - expected response regex
                                    //      ],
                                    //      0,                          - numeric catalogue-unit
                                    //      Object,                     - a callback that returns a truthy value
                                    //  ]
        attempts: args[1].attempts || 2,    // max number of send attempts
        callbacks: Object.assign([args.pop()], { outcomes: !Array.isArray(args[1]) }), // Consumer callback - updated by 'acknowledge'
        conclude: conclude,         // callback to signal State complete
        data: '',                   // received NowIP message
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        list: [],                   // list of catalogue responses
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}

Object.assign(exports, { // class setup
    moreMs: 1000,
    retryMs: 3000,   // extra delay after sending CMD - the XT2 seems quicker than this - but for outgoing alarm calls can be slower - we will align this timer to the outgoing value
    enter: function () {
        debug(this.leg.session.sid, 'enter:', this.args[0], this.args.slice(2));
        this.signal('action');
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        var bs8521,
            data = this.data || this.list.shift() || '';

        debug.enabled && debug(this.leg.session.sid, 'leave:', UTIL.stringify({ type: this.args[0], subtype: this.args[2], data: data }));

        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS', data);
        else
            this.callbacks.shift()(null, data);

        if (['catalogue', 'select'].includes(this.args[0]) && (bs8521 = nowip.parse(data && data.data[0], 'unit,event,location,priority,status'))) {
            if (this.args[0] === 'select')
                this.leg.selected = bs8521.unit;

            Object.assign(this.leg.session.payload.bs8521.$, bs8521.$); // for stringify
            Object.assign(this.leg.session.payload.bs8521, bs8521); // for easy access
            Object.assign(this.leg.session.payload, {
                unit: this.leg.grouped.unit = bs8521.unit,
                originUser: (bs8521.$.controller + bs8521.$.unit).replace(/^0+/, '') || 0,
                event: bs8521.$.event,
                events: [
                    bs8521.$.event + bs8521.$.status,
                    bs8521.$.event + '**',
                    '***' + bs8521.$.status,
                ],
                grouped: true,
                location: bs8521.$.location,
                status: bs8521.$.status,
            });
        }

        this.conclude && this.conclude(data); // Generic
        return this;
    },
    action: function () {
        debug(this.leg.session.sid, 'action: attempts', this.attempts, new Date);
        if (!this.attempts-- || !this.args[1].send)
            return this.enter(null);

        var ms = this.args[1].retryMs || exports.retryMs; 
        debug(this.leg.session.sid, 'action:', this.args[1].send, ms + 'ms', new Date);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), ms);
 
        esl.atm(this.leg.nowIpEvt, { type: this.args[1].type, data: this.args[1].send}, null);
        return this;
    },
    MESSAGE: function (msg) {
        debug(this.leg.session.sid, 'MESSAGE:', msg.body);
        const response = msg.parsed && msg.parsed.ATM;
        this.data = response;
        (this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout)) || this.signal('timeout');  //- clear existing timeout AND immediately signal
        return this;
    },
    timeout: function () {
        debug(this.leg.session.sid, 'timeout:', UTIL.stringify(this.data), '- DONE', new Date);
        
        if (this.data.type[0] === 'A' || !this.args[1].regex) { // received ACK or not seeking a pattern match
            debug(this.leg.session.sid, 'timeout:', this.data.type, '- DONE', new Date);
            this.list.push(this.data) && (this.data = '');
            if (this.conclude) // having a conclude method means we're running a non-ARC/single-stage transaction
                return this.enter(null);
            else if (!this.callbacks.length) // otherwise try calling multi-phase callbacks
                null;
            else if (this.callbacks.outcomes)
                this.callbacks.shift()(null, '+SUCCESS', this.list.shift());
            else
                this.callbacks.shift()(null, this.list.shift());
            return this;

        }  else if (!this.args[1].regex.exec(this.data.data[0])) { // still seeking a pattern match - don't think this actually applies in NowIP - TODO review
            debug(this.leg.session.sid, 'timeout:', this.data, '- MORE', exports.moreMs + 'ms', new Date);
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), exports.moreMs);
            return this;
            
        } else { // pattern match found
            debug(this.leg.session.sid, 'timeout:', this.data.data[0], '- ACK', new Date);
            // TODO why does bs8521 send ACK here..?
            this.list.push(this.data) && (this.data = '');
            return this.enter(null);
        }
    }
});
