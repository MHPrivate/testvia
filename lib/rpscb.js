#! /usr/bin/env node-strict
// redis-pub-sub-callback

if (!module.parent) {
    require('./running').running = undefined; // causes main.running set _true_ once running AND _false_ when terminating
    require('./repletion')({ processGlobal: true, always: !process.stdin.isTTY }); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)
    exports.debug = require('debug');
    exports.secrets = require('..json');
    process.on('rpscb', publish);
}

var argsMap = require('./args-map');
var debug = require('debug')('rpscb');
var main = require.main.exports;
var uuid = require('uuid')

Object.setPrototypeOf(exports, require('events').prototype);
module.exports = Object.assign(exports, {
    defaultMs: 5000, // default timeout
    expires: undefined, // placeholder for timeout Date
    interval: undefined, // placeholder for keepalive ping
    pendings: {}, // pending calbacks {uuid => callback}
    pub: undefined, // placeholder for async publish connection
    publish: publish, // publish(ms, channel, arg, [[args...], [cb]])
    ready: new Promise(ready),
    sub: undefined, // placeholder for dedicated subscribe connection
    timeout: undefined, // placeholder for timeout handle
    uuid: uuid.v1.bind(uuid, node()), // method to generate a uuidv1 based on the local MAC
});

process.running.then(function () {
    exports.pub = require('redis').createClient(main.secrets.redis); // general connection
    exports.pub.on('error', console.log.bind(0, 'rpscb:pub:error:')); // register for errors
    exports.pub.once('ready', ready.bind('pub'));
    exports.sub = exports.pub.duplicate(); // subscription connection
    exports.sub.on('error', console.log.bind(0, 'rpscb:sub:error:')); // register for errors
    exports.sub.once(exports.listenerCount() ? 'subscribe' : 'ready', ready.bind('sub')); // emitted once pending subscriptions are registered
    exports.sub.on('message', onMessage); // register for received messages
    process.once('terminate', function () { // register for shutdown
        exports.interval = clearInterval(exports.interval);
        exports.sub.quit();
        exports.pub.quit();
    });
    exports.interval = setInterval(function () {
        exports.pub.ready && exports.pub.ping(debug.bind(0, 'ping:pub:'));
        exports.sub.ready && exports.sub.ping(debug.bind(0, 'ping:sub:'));
    }, 10000);
});

function node() { // prepare mac based options for uuid.v1()
    var node, ifaces = require('os').networkInterfaces();
    Object.keys(ifaces).some(function (iface, idx, arr) {
        return this[iface].filter(function (address, idx, arr) {
            return !address.internal && address.family === 'IPv4';
        }).some(function (address, idx, arr) {
            node = Buffer(address.mac.replace(/:/g, ''), 'hex'); // used as uuid.v1(uuid)
            return node.mac = address.mac;
        });
    }, ifaces);
    return { node: node };
}

function ready(resolve, reject) { // Promise executor and resolver callback
    if (typeof resolve === 'function') // executor
        return Object.assign(ready, { resolve: resolve, reject: reject, pending: new Set(['pub','sub']) });
    ready.pending.delete(this);
    debug(this + ': ready', ready.pending.size, 'pending');
    ready.pending.size || ready.resolve(new Date);
}

/*  Primary Method
 *  NAME
 *      publish([ms], channel, [args, ...], fn(err, outstanding, ...))
 *
 *  PARAMS
 *      ms : number - response time-limit in ms
 *      channel : string - channel-name to publish
 *      args[] : various - optional arbitary JSON'able parameters to pass
 *      fn(err, outstanding, ...) - optional repeating callback, called one or more times
 *          err : error - exception or null
 *          outstanding : number - how many more times that fn will be called
 *          ... : various - optional parameters from remote
 *
 *  DESCRIPTION
 *      This method wraps the usual redis:publish method to deliver the following
 *      enhancements:
 *      - ability to parse zero or more JSON'able parameters
 *      - option to parse a repeating callback to receive remote responses
 *      - an adjustable timeout for remote responses (default=5000ms)
 *
 *      The optional callback is called repeatedly, once for each publish recipient.
 *
 *      The _outstanding_ parameter to each callback indicates the number of further
 *      callbacks to expect.
 *
 *  RETURNS
 *      a response tracking object that should be considered immutable.
 */
function publish(/* [ms, ]channel, arg, [[args...], [fn]] */) {
    debug.enabled && debug.apply(0, ['publish:'].concat(argsMap(arguments)));
    var args = Array.from(arguments), ms = exports.defaultMs, fn;
    if (typeof args[0] === 'number')
        ms = args.shift();
    if (typeof args[args.length - 1] === 'function')
        fn = args.pop();
    if (typeof args[0] === 'string')
        null;
    else if (fn)
        return fn(new Error('missing required channel'), 0);
    else
        throw new Error('missing required channel');
    var msg = { // message-object to publish
        args: args, // channel and fn will be trimmed below
        cbid: fn && exports.uuid(), // callback-id when has a fn()
    };
    var job = Object.assign(Object.create(msg), { // response tracking object
        await: 0, // callbacks-awaiting
        channel: args.shift(), // publish-name
        date: new Date, // most recent activity - timeout fires _ms_ later
        fn: fn, // callback passed to publish()
        ms: fn && ms, // timeoutMs after most recent activity
    });

    if (fn)
        (exports.pendings[job.cbid] = job) && exports.sub.subscribe(job.cbid); // subscribe to callback-id
    var message = 'j:' + JSON.stringify(msg);
    exports.ready.then(function () {
        debug('publishing:', job.channel, message);
        exports.pub.publish(job.channel, message, function (err, count) { // job-callbacks can preceed this published-callback
            job.await += count || 0;
            if (err || !job.await) { // error OR zero listeners
                if (job.cbid)
                    delete exports.pendings[job.cbid] && exports.sub.unsubscribe(job.cbid); // unsubscribe from callback-id
                debug('published:', job.await, err);
                return fn && job.fn.call(job, err, job.await);
            }
            var expires = job.ms + +new Date;
            if (exports.expires < expires) // another callback expires earlier
                return debug('publish: subsequent');
            exports.expires = expires;
            exports.timeout = clearTimeout(exports.timeout) || setTimeout(onTimeout, expires - +new Date);
        });
    });
    return job;
}

function onTimeout() { // cleanup all expired callbacks and reschedule for next expiry
    var cbids = Object.keys(exports.pendings);
    cbids.length && debug('onTimeout:', cbids.length, 'pending');
    exports.expires = exports.timeout = clearTimeout(exports.timeout);
    var now = new Date;
    for (var cbid in exports.pendings) { // pending callbacks
        var job = exports.pendings[cbid], expires = new Date(job.ms + +job.date);
        if (expires <= now) { // expired
            delete exports.pendings[cbid] && exports.sub.unsubscribe(cbid);
            process.nextTick(job.fn.bind(job, new Error('rpscb timeout'), 0));
        } else if (expires > exports.expires) { // not earliest to expire (handles exports.expires being undefined)
            null;
        } else { // earliest to expire - so far
            exports.expires = expires;
        }
    }
    exports.expires && setTimeout(onTimeout, exports.expires - +new Date);
}

function onMessage(channel, message) {
    debug('onMessage:', channel, message);
    if (!(message || '').startsWith('j:'))
        return debug('onMessage: wrong message format:', message);

    var job, fn, msg = JSON.parse(message.slice(2)); // skip-past the 'j:'
    msg.err = (msg.args || [])[0];
    if (job = exports.pendings[channel]) { // is a callback - invoke job.fn()
        if (msg.err) {
            msg.args[0] = new (global[msg.err.name] || Error)(msg.err.message);
            msg.args[0].stack += msg.err.stack.replace(/.*$/m, '\nremote:');
        }
        msg.args.length ? msg.args.splice(1, 0, --job.await) : msg.args.push(null, --job.await); // insert callbacks-outstanding as arg1
        if (!job.await) // no-further callbacks outstanding - then cleanup
            delete exports.pendings[channel] && exports.sub.unsubscribe(channel);
        job.date = new Date; // reset timeout for a further job.ms period
        try {
            debug.enabled && debug.apply(0, ['callbacking'].concat(msg.args));
            return job.fn.apply(job, msg.args); // deliver callback
        } catch (ex) {
            console.log('callback:', ex);
        }
    }

    // otherwise a call-out - prepare to emit
    msg.args.unshift(channel); // prepend eventName
    msg.cbid && msg.args.push(fn = function (err) { // append a cb() where the call-out has a callback-id
        if (!msg.cbid)
            return;
        var args = Array.from(arguments);

        // JSON'ably transform an Error
        if ((args[0] || {}).stack)
            args[0] = { name: err.name, message: err.sqlMessage || err.message, stack: err.stack };

        var message = 'j:' + JSON.stringify({ args: args });
        debug('callback:', channel, message);
        exports.pub.publish(msg.cbid, message); // publish actual callback

        msg.cbid = null; // prevent repeated callbacks
    });

    try { // dispatch emit
        if (!exports.emit.apply(exports, msg.args)) { // eventName, args, ..., ?cb - deliver call-out
            var message = 'j:' + JSON.stringify({ args: [null] });
            debug('ignored:', channel, message);
            fn && exports.pub.publish(msg.cbid, message); // publish empty callback
        }
    } catch (ex) {
        console.log('call-out:', ex);
        fn && fn(ex);
    }
}

exports.on('removeListener', function (eventName, listener) { // once: called before the listener is called
    var count = this.listenerCount(eventName) // zero for last listener
    debug('removeListener:', eventName, count, this.sub.closing ? 'closing' : '');
    !count && !this.sub.closing && this.sub.unsubscribe(eventName);
});

exports.on('newListener', function (eventName, listener) { // once: called before the listener is recorded
    var count = this.listenerCount(eventName); // zero for first listener
    debug('newListener:', eventName, count);
    !count && this.sub.subscribe(eventName);
});
