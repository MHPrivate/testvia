#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('mosh');
var dgram = require('dgram');
var main = require.main.exports;
var os = require('os');

exports.udps = [];
process.once('terminate', function _mosh() {
    while (exports.udps.length) {
        process.emit('mosh', exports.udps[0].address().port); // announce shutdown
        exports.udps.shift().close();
    }
});

exports.timeoutMs = 60000;
function timeout() { // auto-cleanup sockets idle more than 60s
    var timeoutMs = this.utcMs - Date.now() + exports.timeoutMs;
    if (timeoutMs > 0)
        return setTimeout(timeout.bind(this), timeoutMs).unref();

    debug('timeout:', os.hostname(), this.port, 'close');
    process.emit('mosh', this.port); // announce closure
    this.udp.close();
    var idx = exports.udps.indexOf(this.udp);
    ~idx && exports.udps.splice(idx, 1);
}

function message(msg, rinfo) { // _this_ is the bound locals object
    var ipv6Port = '[' + rinfo.address + ']:' + rinfo.port;
    this.utcMs = Date.now();
    if (!this.larcPort) { // possible ping-message from mosh-server (LARC)
        this.larcPort = (rinfo.address === this.larcIPv6) && rinfo.port;
        this.larcPort && console.log('mosh:', os.hostname(), this.port, 'larc', ipv6Port);
        this.ipv6Port = ipv6Port; // used to identify from-larc messages

    } else if (this.ipv6Port === ipv6Port) { // mosh-server (LARC) to all mosh-client(s) seen in past 60s
        Object.keys(this.clients).map(function (ipv6Port, idx, arr) {
            return this[ipv6Port];
        }, this.clients).forEach(function (client, idx, arr) {
            if (client.utcMs + exports.timeoutMs < this.utcMs) // forget any clients not heard from in past 60s
                return delete this.clients[client.ipv6Port];
            this.udp.send(msg, 0, msg.length, client.port, client.ipv6);
        }, this);

    } else if (this.clients[ipv6Port]) { // existing mosh-client to mosh-server (LARC)
        this.clients[ipv6Port].utcMs = this.utcMs;
        this.larcPort && this.udp.send(msg, 0, msg.length, this.larcPort, this.larcIPv6);

    } else { // new mosh-client to mosh-server (LARC)
        console.log('mosh:', os.hostname(), this.port, 'client', ipv6Port);
        this.clients[ipv6Port] = { ipv6Port: ipv6Port, ipv6: rinfo.address, port: rinfo.port, utcMs: this.utcMs };
        this.larcPort && this.udp.send(msg, 0, msg.length, this.larcPort, this.larcIPv6);

    }
}

exports.larc = larc;
function larc(larcIPv6, cb) { // cb(err, port)
    if (!larcIPv6)
        return cb();
    var locals = {
        clients: {},  // [ipv6]:port => {ipv6, port, utcms}
        ipv6Port: null, // [ipv6]:port of mosh-server (LARC)
        port: Math.floor(Math.random() * 1000 + 60000), // local relaying port
        larcIPv6: larcIPv6,
        larcPort: null, // port of mosh-server (LARC)
        utcMs: null, // timestamp of last seen message
    };
    chain(cb, function () {
        setTimeout(timeout.bind(locals), exports.timeoutMs).unref();
        exports.udps.push(locals.udp = dgram.createSocket('udp6'));
        locals.udp.locals = locals;
        locals.udp.bind(locals.port, this.noerror);

    }, function (err) {
        if (err)
            return larc(larcIPv6, cb); // recurse to have another go
        console.log('mosh:', os.hostname(), locals.port);
        locals.udp.on('message', message.bind(locals));
        this(null, locals.port);

    });
}

process.on('mosh', onMosh);
function onMosh(port, secret, host) {
    // (port, secret, host): setup using info from LARC via redis-peer(host)
    // (port, - -): cleanup
    var locals;
    for (var u in exports.udps)
        if (exports.udps[u].locals.port === port) {
            locals = exports.udps[u].locals;
            break;
        }
    if (!locals)
        return;
    console.log('mosh:', host || os.hostname(), port, secret ? 'secret' : 'relay', secret || '*closed*');
    secret && console.log('mosh:', 'MOSH_KEY=' + secret, 'mosh-client', locals.larcIPv6, locals.larcPort);
}
