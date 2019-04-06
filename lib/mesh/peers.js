#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('mesh:peers');
var events = require('events');
var extend = require('node.extend');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mosh = require('../mosh');
var mysql = require('../mysql');

function argsMap(args) {
    return Array.from(args).map(function (arg, idx, arr) {
        if (typeof arg === 'function')
            return 'function';
        if (typeof arg === 'object')
            return JSON.stringify(arg);
        return arg;
    });
}

module.exports = extend(exports, {
    startUtcms: Date.now() - process.uptime() * 1000,
    emit: emit,
    handlers: { // _this_ is ioSocket, client-side has no _server_ atribute AND server-side has no _close_ method
        connect: function onConnect() { // client-side only - send peering credentials
            debug.enabled && debug.apply(null, [this.mesh.peer, 'onConnect:'].concat(argsMap(arguments)));
            var utc = Date.now() / 1000;
            this.locals.access = { iat: utc - 5, exp: utc + 5, peer: this.mesh.url, startUtcms: exports.startUtcms };
            this.emit('accessJwt', jwt.sign(this.locals.access, main.secrets.peerSecret, { algorithm: 'HS256' }));
            exports.handlers.established.call(this); // signal as established (ioClient workaround)
        },
        established: function onEstablished() { // faked by exports() & 'connect' - peer connection established
            debug.enabled && debug.bind(null, [this.mesh.peer, 'onEstablished:'].concat(argsMap(arguments)));
        },
        disconnecting: function onDisconnecting(reason) { // peer disconnect
            debug.enabled && debug.apply(null, [this.mesh.peer, 'onDisconnecting:'].concat(argsMap(arguments)));
        },
        heartbeat: function onHeartbeat() { // client heartbeat
            debug.enabled && debug.apply(null, [this.mesh.peer, 'onHeartbeat:'].concat(argsMap(arguments)));
        },
        certificate: function onCertificate(fqdn) { // renew certificate, initiate local-adoption or larc-update
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onCertificate:'].concat(argsMap(arguments)));
            var soc = this;
            chain(null, function () {
                this.index = soc.mesh.peer;
                mysql('select f.*,l.chain from fqdns f left join leChains l on f.chainId=l.id where f.fqdn=?', [fqdn], this);

            }, function (rows, meta) {
                var row = rows.shift();
                row && process.emit('certificate', { fqdn: row.fqdn, cert: row.cert, chain: row.chain, key: row.privkey });
                this();

            });
        },
        log: function onLog(data) {
            console.log.apply(console, [this.mesh.peer, 'mesh:peers:log'].concat(argsMap(arguments)));
        },
        find2: function onFind2(larcId, cb) { // larcId, cb(err, ourUrl)
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onFind2:'].concat(argsMap(arguments)));
            if (typeof cb !== 'function')
                cb = function () { };
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return cb(null, this.mesh.url);
            cb();
        },
        mosh: function onMosh(data) { // peer sharing of LARC submissions via POST /v1/mosh from POST /v1/larc responses
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onMosh:'].concat(argsMap(arguments)));
            process.emit('mosh', data.port, data.secret, data.host);
        },
        mosh2: function onMosh2(larcId, cb) { // larcId, cb(err, { host, port, secret })
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onMosh2:'].concat(argsMap(arguments)));
            if (typeof cb !== 'function')
                cb = function () { };
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return chain(cb, function () {
                        mosh.larc(this.mesh.clients[i].locals.ipv6, this);

                    }, function (port) {
                        this.mesh.clients[i].emit('mosh2', data = { host: os.hostname(), port: port }, this);

                    }, function (secret) {
                        secret ? this(null, extend(data, { secret: secret })) : this();

                    });
            cb();
        },
        drop2: function onDrop2(larcId, cb) { // larcId, cb(err, ourUrl)
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onDrop2:'].concat(argsMap(arguments)));
            if (typeof cb !== 'function')
                cb = function () { };
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return this.mesh.clients[i].disconnect() && cb(null, this.mesh.url);
            cb();
        },
        misc2: function onMisc2(larcId, event /* , ..., cb */) { // larcId, event, ..., cb(err, ...)
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onMisc2:'].concat(argsMap(arguments)));
            var cb = arguments[arguments.length - 1];
            if (typeof cb !== 'function')
                cb = function () { };
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId !== larcId)
                    continue;
                else if (!event) // find2
                    return cb(null, this.mesh.url);
                else
                    return this.mesh.clients[i].emit.apply(this.mesh.clients[i], Array.from(arguments).slice(1));
            cb();
        },
        proxy2: function onProxy(larcId /* , proxy, ..., cb */) { // larcId, {appUrl, sipUrl, secret}, bool, cb(err, peerurl) - cb not passed to larc
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onProxy2:'].concat(argsMap(arguments)));
            var args = Array.from(arguments).slice(1);
            var cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : function () { };
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return this.mesh.clients[i].emit.apply(this.mesh.clients[i], ['proxy'].concat(args)) && cb(null, this.mesh.url);
            cb();
        },
    },
    mesh: null, // will be require('.') once running
    misc2: misc2,
});

process.once('running', function () { // delayed _require_ is necessary as it loads us
    exports.mesh = require('.');
});

function exports(done) { // _this_ is the ioSocket
    if (typeof done !== 'function')
        throw new Error('method expects callback argument');
    this.locals.peer = this.mesh.peer;
    debug('setup:', this.locals.peer);

    var soc = this;
    Object.keys(exports.handlers).forEach(function (handler, idx, arr) {
        soc.on(handler, this[handler]);
    }, exports.handlers);
    events.prototype.emit.call(soc, 'established'); // signal as established (ioServer normal)
    done();
}

function emit(event /* , ... */) {
    for (var idx in this.mesh.lsnrs) { // foreach listener socket
        var lsnr = this.mesh.lsnrs[idx];
        for (var url in lsnr.mesh.peers) // foreach peer of the listener socket
            lsnr.mesh.peers[url].emit.apply(lsnr.mesh.peers[url], arguments);
    }
}

//function once(func) {
//    return function once() {
//        once.func = func;
//        func = undefined;
//        return once.func && once.func.apply(this, arguments);
//    }
//}

function misc2(larcId, event /* ..., cb */) {
    var n = 0, args = Array.from(arguments).slice(1);
    var cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : console.log;
    event = typeof event === 'string' ? args.shift() : 'find2';
    if (!this.handlers[event])
        return cb(new Error('unknown peer event: ' + event));
    for (var l in this.mesh.lsnrs) { // check if larcId is a client of us of any of our listeners
        ++n;
        var lsnr = this.mesh.lsnrs[l];
        this.handlers[event].apply(lsnr, [larcId].concat(args, function (err /* , ... */) {
            debug(lsnr.mesh.url, 'misc2: local', arguments.length);
            --n;
            if (cb && arguments.length > 1)
                cb = cb.apply(null, arguments) && undefined; // forget cb once called
        }));
        if (!cb) // callback already invoked - don't forward to peers
            break;
        Object.keys(lsnr.mesh.peers).forEach(function (url, idx, arr) { // forward request to each peer
            function larcCb(err /* , ... */) { // iteration private instance with private access to scoped timeout variable
                debug(url, 'misc2: remote', arguments.length)
                if (!timeout) // protects against multiple calling
                    return;
                timeout = clearTimeout(timeout);
                if (err === 'timeout') // need to cleanup the outstanding _ack_ callback
                    for (var ack in peer.acks)
                        if (peer.acks[ack] === larcCb)
                            delete peer.acks[ack];
                --n;
                if (cb && (arguments.length > 1 || !n))
                    cb = cb.apply(null, arguments) && undefined; // forget cb once called
            }
            ++n;
            var peer = lsnr.mesh.peers[url];
            peer.emit.apply(peer, [event, larcId].concat(args, larcCb));
            var timeout = setTimeout(larcCb, 5000, 'timeout');
        }, lsnr.mesh.peers);
    }
    if (cb && !n) // zero outstanding requests - so invoke cb()
        cb = cb() && undefined; // forget cb once called
}

['drop2', 'find2', 'mosh2', 'proxy2'].forEach(function (name, idx, arr) {
    exports[name] = setFunctionName(name, function (larcId /* , ... , cb */) {
        var args = Array.from(arguments).slice(1);
        misc2.apply(this, [larcId, name].concat(args));
    });
});

// permitted trick, see 'To change it, you could use Object.defineProperty() though.' here:
//  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/name#Inferred_function_names
function setFunctionName(name, func) {
    var desc = Object.getOwnPropertyDescriptor(func, 'name');
    desc.writable || Object.defineProperty(func, 'name', { writable: true }); // conditionally make 'name' _writable_
    Object.defineProperty(func, 'name', { value: name, writable: desc.writable }); // set 'name' and restore _writeable_
    return func; // return func to enable one-line function creation & naming
}
