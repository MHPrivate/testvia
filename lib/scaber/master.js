#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cluster = require('cluster');
var debug = require('debug')('master');
var events = require('events');
var main = require.main.exports;
var webio = require('./webio');

module.exports = Object.defineProperties(Object.assign(Object.setPrototypeOf(exports, cluster), { // cluster: disconnect, exit, fork, listening, message, online, setup
    handle: undefined, // dummy passed to all messaging functions
    sendCb: function sendCb(worker, message, handle, cb) {
        sendCb.ids || (sendCb.ids = 0);
        message = Object.assign({ ack: ++sendCb.ids }, message); // local clone
        sendCb[message.ack] = function _sendCb(message, handle) {
            delete sendCb[message.ack] && cb.apply(worker, arguments);
        };
        worker.send(message, handle, function (err) {
            err && delete sendCb[message.ack] && console.log('master:sendCb:', err);
        });
    },
    sent: function sent(txt) { // callback factory helper for calls to worker.send(message, handle, cb)
        return function (err) { err && console.log(txt + ':', err) };
    },
    sessions: {}, // { $origin$unique => worker }
}), {
    handle: { enumerable: false, writable: false },
    sendCb: { enumerable: false },
    sent: { enumerable: false },
});
var handle = undefined;

// websvc/master transactions - all utilise emit-callback
//  RESTful |       Collection          |           Member              |
//  --------+---------------------------+-------------------------------+
//  get     | (list collection)         | FETCH SESSION         ===>    |
//  post    | CREATE SESSION    <==>    | SUPPLIMENT SESSION    ===>    |
//  put     | (replace sessions)        | (replace session)             |
//  patch   | (update sessions)         | (update session)              |
//  delete  | (delete sessions)         | DELETE SESSION        <==>    |

// master/worker transactions
//  |       Master          |       Worker          |
//  +-----------------------+-----------------------+
//  | retire    =>>         | => <<=    offer       |
//  | auction   =>>         |    <<=    expire      |
//  | json      =>> <=      |                       |
//  | flush     =>>         |                       |
//  | fetch     =>> <=      |                       |


// ************************************************************************************************
// ******************************* worker message handling ****************************************
// ************************************************************************************************
// master/worker message types:
//   notify:    { event, sid }
//   request:   { ack, event, sid, ... }
//   reply:     { ack, err, ... }
cluster.on('disconnect', function onMasterDisconnect(worker) { // worker:disconnect(worker) - refork if last worker
    debug.enabled && debug.apply(0, ['masterDisconnect#' + worker.id].concat(argsMap(arguments)));
    for (var sid in exports)
        if (exports.sessions[sid] === worker)
            delete exports.sessions[sid];
    for (var wid in cluster.workers) // check for other workers
        if (+wid !== worker.id && cluster.workers[wid].isConnected())
            return;
    if (!main.running) // not terminating
        return;
    console.log('masterDisconnect: refork');
    cluster.fork();
});
cluster.on('fork', function onMasterFork(worker) { // worker:fork(worker) - add locals container object
    debug.enabled && debug.apply(0, ['masterFork#' + worker.id].concat(argsMap(arguments)));
    worker.locals = {}; // worker state
});
cluster.on('message', function onMasterMessage(worker, message, handle) { // worker:message(worker, message, handle) - process message from worker
    debug.enabled && debug.apply(0, ['--- master:message' + (message.ack && !message.event ? 'Cb#' : '#') + worker.id].concat(argsMap(arguments)));
    var event = [message.event], ack = message.ack, messageCb = message.ack && function (reply, handle, sent) {
            debug.enabled && debug.apply(0, ['--- master:messageCb#' + worker.id].concat(argsMap(arguments)));
            worker.send(Object.assign({ ack: ack }, reply), handle, sent);
        }.bind(worker);
    try {
        if (message.event) { // worker request
            delete message.event && messageCb && delete message.ack; // remove event & ack attributes
            event.push('master' + event[0].charAt(0).toUpperCase() + event[0].slice(1));
            cluster.emit(event[1], worker, message, handle, messageCb) || console.log('onMasterMessage:', event[0], '- not implemented', event[1]);
        } if (ack && exports.sendCb[ack]) { // worker response - invoke registered callback
            delete message.ack;
            exports.sendCb[ack].apply(worker, Array.from(arguments).slice(1));
        }
    } catch (ex) {
        console.log('onMasterMessage#' + worker.id, ex);
    }
});
cluster.on('online', function onMasterOnline(worker) { // worker:online(worker) - retire any other workers
    debug.enabled && debug.apply(0, ['masterOnline#' + worker.id].concat(argsMap(arguments)));
    for (var wid in cluster.workers)
        if (+wid !== worker.id && !cluster.workers[wid].locals.retired) {
            cluster.workers[wid].locals.retired = new Date;
            cluster.workers[wid].send({ event: 'retire' }, handle, exports.sent('onMasterOnline')); // notify
        }
});
cluster.on('masterOffer', function onMasterOffer(worker, offer, handle, cb) { // worker, { ack, sid: '$origin$unique' }, handle, cb({}, handle, sent)
    debug.enabled && debug.apply(0, ['04< master:offer#' + worker.id].concat(argsMap(arguments)));
    var reject = { ack: offer.ack, err: { name: 'Info', message: 'offer rejected', sibling: true } };
    if (!offer.sid || exports.sessions[offer.sid]) { // missing sid OR already assigned
        debug.enabled && debug('06> master:offerCb#' + worker.id, JSON.stringify(reject));
        return cb(reject, handle, exports.sent('onMasterOffer rejected')); // reply
    }

    exports.sessions[offer.sid] = worker; // save candidate worker and forward offer to websvc
    var forward = Object.assign({ method: 'post' }, offer);
    debug.enabled && debug('<05 master:offer', JSON.stringify(forward));
    webio.emit('request', forward, function onWebioOfferCb(err) {
        debug.enabled && debug.apply(0, [!err ? '>07 master:offerCb': '>09 master:offerCb'].concat(argsMap(arguments)));
        var message = !err ? {} : { err: err, sibling: false };
        err && delete exports.sessions[offer.sid];
        debug.enabled && debug((!err ? '08>' : '10>') + ' master:offerCb#' + worker.id, JSON.stringify(message));
        cb(message, handle, exports.sent('onWebioOfferCb')); // reply
    });
});
cluster.on('masterExpire', function onMasterExpire(worker, expire, handle) { // worker, { sid: '$origin$unique' }, handle
    debug.enabled && debug.apply(0, ['??< master:expire#' + worker.id].concat(argsMap(arguments)));
    if ((exports.sessions[expire.sid] || worker) !== worker)
        return debug.enabled && debug('Error: expire for ' + expire.sid + ' expected from worker#' + exports.sessions[expire.sid].id + ' not worker#' + worker.id);
    delete exports.sessions[expire.sid];
    var forward = Object.assign({ method: 'delete' }, expire);
    debug.enabled && debug('<?? master:expire', JSON.stringify(forward));
    webio.emit('request', forward, function onWebioExpireCb(err) {
        debug.enabled && debug.apply(0, ['>?? master:expireCb'].concat(argsMap(arguments)));
    });
});

// ************************************************************************************************
// ******************************* websvc message handling ****************************************
// ************************************************************************************************
process.on('webioConnect', function onWebioConnect() {
    debug.enabled && debug.apply(0, ['onWebioConnect:'].concat(argsMap(arguments)));

    var sids = Object.keys(exports.sessions);
    if (!sids.length)
        return;
    var sessions = { method: 'post', sids: sids };
    debug.enabled && debug('onWebioConnectCb:', JSON.stringify(sessions));
    sessions.sids.length && webio.emit('request', sessions);
});

process.on('webio', function onWebio(message, cb) { // webio(message, cb(err, reply)) - forward to method-type handler
    var event = message.method + (!message.sid ? 'Collection' : 'Member');
    delete message.method; // remove method
    cluster.emit(event, message, cb) || cb(new Error(event + ' not supported'));
})

// return catalogue of Alarm IDs
cluster.on('getCollection', function onGetCollection(message, cb) { // webio:getCollection({ method }, cb(err, { uaids: [] }))
    debug.enabled && debug.apply(0, ['onGetCollection:'].concat(argsMap(arguments)));
    cb(new Error('getCollection not implemented'));
});
cluster.on('getMember', function onGetMember(fetch, cb) { // webio: getMember({ sid }, cb(err, {}))
    debug.enabled && debug.apply(0, ['>?? master:fetch'].concat(argsMap(arguments)));
    var err, worker = exports.sessions[fetch.sid];
    if (!worker) {
        debug.enabled && debug('<-- master:fetchCb', JSON.stringify(err = new Error('unknown session ' + fetch.sid)));
        return cb(err);
    }

    var forward = Object.assign({ event: 'fetch' }, fetch);
    debug.enabled && debug('??> master:fetch#' + worker.id, JSON.stringify(forward));
    exports.sendCb(worker, forward, exports.handle, function (reply) { // { ?err, ?media }
        debug.enabled && debug('??< master:fetchCb', reply.err ? Error.prototype.toString.call(reply.err) : JSON.stringify(reply));
        debug.enabled && debug('<?? master:fetchCb', reply.err ? Error.prototype.toString.call(reply.err) : JSON.stringify(reply));
        reply.err ? cb(reply.err) : cb(null, reply);
    });
});

// websvc request to auction a session
cluster.on('postCollection', function onPostCollection(auction, cb) { // webio: postCollection({ method: 'post', origin, unique }, cb(err, { bidders: Number }))
    debug.enabled && debug.apply(0, ['>01 master:auction'].concat(argsMap(arguments)));
    var reply = { bidders: 0 }, message = { event: 'auction', origin: auction.origin, unique: auction.unique };
    for (var wid in cluster.workers)
        if (!cluster.workers[wid].locals.retired) {
            debug.enabled && debug('02> master:auction#' + wid, JSON.stringify(message));
            cluster.workers[wid].send(message, exports.handle, exports.sent('master:auction ' + wid)) && ++reply.bidders;
        }
    debug.enabled && debug('<03 master:auctionCb', JSON.stringify(reply));
    cb(null, reply);
});

// websvc delivery of session json
cluster.on('postMember', function onPostMember(json, cb) { // webio: postMember({ method: 'post', sid: '$origin$unique' }, cb(err, {}))
    debug.enabled && debug.apply(0, ['>11 master:json'].concat(argsMap(arguments)));
    var err, worker = exports.sessions[json.sid];
    if (!worker) {
        debug.enabled && debug('<12 master:jsonCb', JSON.stringify(err = new Error('unknown session ' + json.sid)));
        return cb(err);
    }

    var forward = Object.assign({ event: 'json' }, json);
    debug.enabled && debug('13> master:json#' + worker.id, JSON.stringify(forward));
    exports.sendCb(worker, forward, exports.handle, function (reply) { // { ?err, ?media }
        debug.enabled && debug('14< master:jsonCb', reply.err ? Error.prototype.toString.call(reply.err) : JSON.stringify(reply));
        debug.enabled && debug('<15 master:jsonCb', reply.err ? Error.prototype.toString.call(reply.err) : JSON.stringify(reply));
        reply.err ? cb(reply.err) : cb(null, reply);
    });
});

cluster.on('putCollection', function onPutCollection(message, cb) { // webio: putCollection({}, cb(err, {}))
    debug.enabled && debug.apply(0, ['onWebioPutCollection:'].concat(argsMap(arguments)));
    cb(new Error('putCollection not implemented'));
});
cluster.on('putMember', function onPutMember(message, cb) { // webio: putMember({}, cb(err, {}))
    debug.enabled && debug.apply(0, ['onWebioPutMember:'].concat(argsMap(arguments)));
    cb(new Error('putMember not implemented'));
});

cluster.on('patchCollection', function onPatchCollection(message, cb) { // webio: patchCollection({}, cb(err, {}))
    debug.enabled && debug.apply(0, ['onWebioPatchCollection:'].concat(argsMap(arguments)));
    cb(new Error('patchCollection not implemented'));
});
cluster.on('patchMember', function onPatchMember(message, cb) { // webio: patchMember({}, cb(err, {}))
    debug.enabled && debug.apply(0, ['onWebioPatchMember:'].concat(argsMap(arguments)));
    cb(new Error('patchMember not implemented'));
});

cluster.on('deleteCollection', function onDeleteCollection(message, cb) { // webio: deleteCollection({}, cb(err, {}))
    debug.enabled && debug.apply(0, ['onWebioDeleteCollection:'].concat(argsMap(arguments)));
    cb(new Error('deleteCollection not implemented'));
});
cluster.on('deleteMember', function onDeleteMember(flush, cb) { // webio: deleteMember({}, cb(err, { sid }))
    debug.enabled && debug.apply(0, ['>?? master:flush'].concat(argsMap(arguments)));
    var err, worker = exports.sessions[flush.sid];
    if (!worker) {
        debug.enabled && debug('<12 master:flushCb', JSON.stringify(err = new Error('unknown session ' + flush.sid)));
        return cb(err);
    }

    var forward = Object.assign({ event: 'flush' }, flush); // mask method from worker
    debug.enabled && debug('??> master:flush#' + worker.id, JSON.stringify(forward));
    worker.send(forward, exports.handle, exports.sent('onDeleteMember'));

    var reply = {};
    debug.enabled && debug('<?? master:flushCb', JSON.stringify(reply));
    cb(null, reply);
});
