#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('mesh:peers');
var events = require('events');
var extend = require('node.extend');
var jwt = require('jsonwebtoken');
var main = process.mainModule.exports;
//var mosh = require('../mosh');

module.exports = extend(exports,{
    startUtcms: Date.now() - process.uptime() * 1000,
    emit: emit,
    handlers: { // _this_ is ioSocket, client-side has no _server_ atribute AND server-side has no _close_ method
        connect: function onConnect() { // client-side only - send peering credentials
            debug.enabled && debug.apply(null, ['onConnect:', this.mesh.peer].concat(Array.from(arguments)));
            var utc = Date.now() / 1000;
            this.locals.access = { iat: utc - 5, exp: utc + 5, peer: this.mesh.url, startUtcms: exports.startUtcms };
            this.emit('accessJwt', jwt.sign(this.locals.access, main.secrets.peerSecret, { algorithm: 'HS256' }));
            exports.handlers.established.call(this); // signal as established (ioClient workaround)
        },
        established: function onEstablished() { // faked by exports() & 'connect' - peer connection established
            debug.enabled && debug.bind(null, ['onEstablished:', this.mesh.peer].concat(Array.from(arguments)));
        },
        disconnect: function onDisconnect(reason) { // peer disconnect
            debug.enabled && debug.apply(null, ['onDisconnect:', this.mesh.peer].concat(Array.from(arguments)));
        },
        heartbeat: function onHeartbeat() { // client heartbeat
            debug.enabled && debug.apply(null, ['onHeartbeat:', this.mesh.peer].concat(Array.from(arguments)));
        },
        certificate: function onCertificate(fqdn) { // renew certificate, initiate local-adoption or larc-update
            debug.enabled && debug.apply(null, ['onCertificate:', this.mesh.peer].concat(Array.from(arguments)));
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
            console.log.apply(console, ['mesh:peers:log', this.mesh.peer].concat(Array.from(arguments)));
        },
        find2: function onFind2(larcId, cb) { // larcId, cb(err, ourUrl)
            debug.enabled && debug('onFind2:', this.mesh.peer, larcId, typeof cb);
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return cb(null, this.mosh.url);
            cb();
        },
        mosh: function onMosh(data) { // hq upto '2018-06-26T18:09:00:04.000Z' inclusive
            debug.enabled && debug.apply(null, ['onMosh:', this.mesh.peer].concat(Array.from(arguments)));
            process.emit('mosh', data.port, data.secret, data.host);
        },
        mosh2: function onMosh2(larcId, cb) { // larcId, cb(err, { host, port, secret })
            debug.enabled && debug('onMosh2:', this.mesh.peer, larcId, typeof cb);
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return chain(cb, function () {
                        mosh.server(this.mesh.clients[i].locals.ipv6, this);

                    }, function (port) {
                        this.mesh.clients[i].emit('mosh2', data = { host: os.hostname(), port: port }, this);

                    }, function (secret) {
                        secret ? this(null, extend(data, { secret: secret })) : this();

                    });
            cb();
        },
        drop2: function onDrop2(larcId, cb) { // larcId, cb(err, ourUrl)
            debug.enabled && debug('onDrop2:', this.mesh.peer, larcId, typeof cb);
            for (var i in this.mesh.clients)
                if ((this.mesh.clients[i].locals.access || {}).larcId === larcId)
                    return this.mesh.clients[i].disconnect() && cb(null, this.mesh.url);
            cb();
        },
        misc2: function onMisc2(larcId, event/* , ..., cb */) { // larcId, event, ..., cb(err, ...)
            debug.enabled && debug.apply(null, ['onMisc2:', this.mesh.peer].concat(Array.from(arguments).map(function (arg, idx, arr) {
                return typeof arg === 'function' ? 'function' : arg;
            })));
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
    },
    mesh: null, // will be require('.') when first needed
    misc2: misc2,
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
    this.mesh || (this.mesh = require('.')); // delayed _require_ is necessary as it loads us
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
    this.mesh || (this.mesh = require('.')); // delayed _require_ is necessary as it loads us
    var n, args = Array.from(arguments).slice(1);
    var cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : console.log;
    event = typeof event === 'string' ? args.shift() : 'find2';
    if (!this.handlers[event])
        return cb(new Error('unknown peer event: ' + event));
    for (var l in this.mesh.lsnrs) { // check if larcId is a client of us on any of our listeners
        var lsnr = this.mesh.lsnrs[l];
        ++n;
        this.handlers[event].apply(lsnr, [larcId].concat(args, function (err, data /* , ... */) {
            --n;
            if (cb && arguments.length > 1)
                cb = cb.apply(null, arguments) && undefined; // forget cb once called
        }));
        if (!cb) // callback already invoked - don't forward to peers
            break;
        for (var url in lsnr.mesh.peers) { // forward request to each peer
            var peer = lsnr.mesh.peers[url];
            ++n;
            peer.emit.apply(peer, [event, larcId].concat(args, function (err, data) {
                --n;
                if (cb && (arguments.length > 1 || !n))
                    cb = cb.apply(null, arguments) && undefined;
            }));
        }
    }
    if (cb && !n) // zero outstanding requests - so invoke cb()
        cb = cb() && undefined; // forget cb once called
}

['drop2', 'find2', 'mosh2'].forEach(function (name, idx, arr) {
    exports[name] = setFunctionName(name, function (larcId /* , cb */) {
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
