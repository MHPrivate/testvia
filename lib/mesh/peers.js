#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('mesh:peers');
var events = require('events');
var extend = require('node.extend');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mosh = require('../mosh');
var mysql = require('../mysql');
var os = require('os');
var setFunctionName = require('../name-function');

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
            cb.mesh = this.mesh; // expose mesh to chain methods (below)
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return chain(cb, function () {
                        mosh.larc(this.mesh.clients[i].locals.ipv6, this);

                    }, function (port) {
                        this.mesh.clients[i].emit('mosh2', this.data = { host: os.hostname(), port: port }, this);

                    }, function (secret) {
                        secret ? this(null, extend(this.data, { secret: secret })) : this();

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
        larc2: function onLarc2(larcId, event /* , ..., cb */) { // larcId, event, ..., cb(err, ...)
            debug.enabled && debug.apply(null, [this.mesh.peer || this.mesh.url, 'onLarc2:'].concat(argsMap(arguments)));
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
    larc2: larc2,
    mesh: null, // will be require('.') once running
    peers: peers,
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

function peers(event /* , ... */) {
    if (!this.handlers[event])
        throw new Error('unknown peer event: ' + event);
    var args = Array.from(arguments);
    debug(this.mesh.lsnrs[0].mesh.url, 'peers: local', args.length - 1);
    this.handlers[event].apply(this.mesh.lsnrs[0], args.slice(1));
    for (var l in this.mesh.lsnrs) {
        var lsnr = this.mesh.lsnrs[l];
        Object.keys(lsnr.mesh.peers).forEach(function (url, idx, arr) {
            debug(url, 'peers: remote', args.length - 1);
            this[url].emit.apply(this[url], args);
        }, lsnr.mesh.peers);
    }
}

function larc2(larcId, event /* , ..., cb */) {
    var n = 0, args = Array.from(arguments).slice(1);
    var cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : console.log;
    event = typeof event === 'string' ? args.shift() : 'find2';
    if (!this.handlers[event])
        return cb(new Error('unknown peer event: ' + event));

    ++n;
    this.handlers[event].apply(this.mesh.lsnrs[0], [larcId].concat(args, function (err /* , ... */) {
        err && console.log('larc2: error', err);
        debug(this.mesh.lsnrs[0].mesh.url, 'larc2: local', arguments.length);
        --n;
        if (cb && arguments.length > 1)
            cb = cb.apply(null, arguments) && undefined; // forget cb once called
    }.bind(this)));
    if (!cb) // callback already invoked - don't forward to peers
        return;

    for (var l in this.mesh.lsnrs) { // check if larcId is a client of us of any of our listeners
        var lsnr = this.mesh.lsnrs[l];
        Object.keys(lsnr.mesh.peers).forEach(function (url, idx, arr) { // forward request to each peer
            var timeout, peer = this[url];
            function larcCb(err /* , ... */) { // iteration private instance with private access to scoped timeout variable
                debug(url, 'larc2: remote', arguments.length)
                if (!timeout) // protects against multiple calling
                    return;
                timeout = clearTimeout(timeout);
                if (err === 'timeout') // need to cleanup the outstanding _ack_ callback
                    for (var ack in peer.acks)
                        if (peer.acks[ack] === larcCb)
                            delete peer.acks[ack];
                --n;
                if (cb && (!n || arguments.length > 1))
                    cb = cb.apply(null, arguments) && undefined; // forget cb once called
            }
            ++n;
            peer.emit.apply(peer, [event, larcId].concat(args, larcCb));
            timeout = setTimeout(larcCb, 5000, 'timeout');
        }, lsnr.mesh.peers);
    }
    if (cb && !n) // zero outstanding requests - so invoke cb()
        cb = cb() && undefined; // forget cb once called
}

['drop2', 'find2', 'mosh2', 'proxy2'].forEach(function (name, idx, arr) {
    exports[name] = setFunctionName(name, function (larcId /* , ... , cb */) {
        var args = Array.from(arguments).slice(1);
        larc2.apply(this, [larcId, name].concat(args));
    });
});
