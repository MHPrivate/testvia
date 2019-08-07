#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('mesh');
var extend = require('node.extend');
var ipaddr = require('ipaddr.js');
var jwt = require('jsonwebtoken');
var larcs = require('./larcs');
var main = require.main.exports;
var mio = require('../mesh.io');
var mysql = require('../../lib/mysql');
var peers = require('./peers');

module.exports = extend(exports, {
    accessJwt: accessJwt,
    durationSec: 86400 * 7, // lifetime of jsonwebtokens
    identity: null, // typically https://<hostname>:<port> of this service instance
    lsnrAddPeer: lsnrAddPeer,
    lsnrs: [], // array of listener sockets
});

var setup;
function exports(svr) { // module function to activate mesh.io on an httpServer
    exports.lsnrs.push(svr.io = mio(svr));
    debug('setup:', svr.io.mesh.url);
    exports.identity = exports.identity || svr.io.mesh.url;
    svr.io.on('connection', onConnection);

    var close = svr.close;
    svr.close = function () {
        debug('close');
        var idx = exports.lsnrs.indexOf(svr.io);
        ~idx && exports.lsnrs.splice(idx, 1);
        svr.close = close; // restore httpServer:close to be invoked by socket.io:close
        return svr.io.close.apply(svr.io, arguments); // invokes socket.io:close
    }

    if (!setup)
        setup = main.secrets.peers.slice();
    while (setup.length) // spin over the list of peer url(s)
        setup[0] === svr.io.mesh.url ? setup.shift() : lsnrAddPeer(setup.shift(), svr.io);

    chain(null, function () {
        this.index = 'startup';
        mysql('update larcs set linker=NULL,linkId=NULL where linker=?', [svr.io.mesh.url], this);

    });
}

function lsnrAddPeer(peerUrl, lsnr) { // listener on which to mount the peer, peerUrl to add
    lsnr || (lsnr = exports.lsnrs[0]);
    if (!lsnr || !peerUrl || peerUrl === lsnr.mesh.url)
        return peerUrl && debug('not adding peer:', peerUrl);
    debug('adding peer:', peerUrl);
    var soc = extend(lsnr.addPeer(peerUrl), { locals: {} });
    Object.keys(peers.handlers).forEach(function (handler, idx, arr) { // foreach named handler
        soc.on(handler, this[handler]); // handler function for that handler name
    }, peers.handlers);
}

function onConnection(soc) { // _this_ is the listener
    debug('onConnection:', soc.handshake.address);
    var locals = soc.locals = {
        authority: false, // on the next heartbeat, the remote needs to send the public part of our renewed HTTPS certificate
        certificate: false, // LEGACY: unknown usage
        ip: ipaddr.IPv6.parse(soc.handshake.address),
        ipv6: soc.handshake.address,
    };
    if (locals.ip.isIPv4MappedAddress())
        locals.ipv4 = locals.ip.toIPv4Address().toString();
    soc.once('accessJwt', onceAccessJwt);
    soc.conn.prependOnceListener('heartbeat', soc.removeListener.bind(soc, 'accessJwt', onceAccessJwt)); // prepend so this clean preempts mesh.io:heartbeat
}

function onceAccessJwt(accessJwt, gitdate, cb) { // _this_ is the ioSocket
    // { iat, exp, peer, startUtcms } - peer
    // { iat, exp, larcId, name, ?schemeId, ?dialPrefix } - larc
    console.log.apply(console, ['onceAccessJwt:', this.handshake.address].concat(Array.from(arguments).slice(0, -1)));
    var soc = this;
    chain(function cleanup(err) {
        if (!err)
            return cb && cb.apply(this, arguments);
        console.log('onceAccessJwt:', err);
        cb && cb.apply(this, Array.from(arguments).map(function (arg, idx, arr) {
            return idx ? arg : arg.toString();
        }));

    }, function () {
        jwt.verify(accessJwt, main.secrets.peerSecret, this.noerror);

    }, function (err, access) {
        if (err)
            return soc.disconnect();
        soc.locals.access = access;
        access.dialPrefix && (soc.locals.fqdn = access.dialPrefix + '.hq.' + main.secrets.fqdn);
        mio.fixClient(soc, access.peer); // fixup for legacy clients not based on mesh.io - access.peer will be undefined for non-peers
        soc.mesh.peer && (soc.locals.peer = soc.mesh.peer);
        if (access.peer)
            return peers.call(soc, this);
        if (access.larcId)
            return larcs.call(soc, gitdate, this);
        this();

    });
}

function accessJwt(obj) {
    var utc = Date.now() / 1000;
    obj.iat || (obj.iat = utc);
    obj.exp = utc + exports.durationSec;
    return jwt.sign(obj, main.secrets.peerSecret, { algorithm: 'HS256' });
}
