#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var debug = require('debug')('mesh');
var events = require('events');
var ipaddr = require('ipaddr.js');
var jwt = require('jsonwebtoken');
var larcs = require('./larcs');
var main = require.main.exports;
var meshio = require('../mesh.io');
var mysql = require('../mysql');
var scabs = require('./scabs');

module.exports = Object.assign(exports, {
    accessJwt: accessJwt,
    durationSec: 86400 * 7, // lifetime of jsonwebtokens
    lsnrs: [], // array of listener sockets
    updateSec: 86400 * 7 * 0.25, // refresh accessJwt after 75% of durationSec
});

function exports(svr) { // module function to activate mesh.io on an httpServer
    exports.lsnrs.push(svr.io = meshio(svr));
    debug('setup:', svr.io.mesh.url);
    main.identity = main.identity || svr.io.mesh.url;
    svr.io.on('connection', onConnection);

    var close = svr.close;
    svr.close = function () {
        debug('close');
        var idx = exports.lsnrs.indexOf(svr.io);
        ~idx && exports.lsnrs.splice(idx, 1);
        svr.close = close; // restore httpServer:close to be invoked by socket.io:close
        return svr.io.close.apply(svr.io, arguments); // invokes socket.io:close
    }

    chain(null, function () {
        this.index = 'flushLarcs';
        mysql('update larcs set linker=NULL,linkId=NULL where linker=?', [svr.io.mesh.url], this);

    });
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
    soc.conn.on('heartbeat', events.prototype.emit.bind(soc, 'heartbeat')); // share io.connection heartbeat with io.socket
    soc.once('accessJwt', onceAccessJwt);
    soc.conn.prependOnceListener('heartbeat', soc.removeListener.bind(soc, 'accessJwt', onceAccessJwt)); // prepend so this clean preempts mesh.io:heartbeat
}

function onceAccessJwt(accessJwt, statement, cb) { // _this_ is the ioSocket
    // { iat, exp, larcId, name, ?schemeId, ?dialPrefix } - larc
    debug.enabled && debug.apply(0, ['onceAccessJwt:', this.handshake.address].concat(argsMap(arguments)));
    if (typeof statement !== 'object') // legacy
        statement = { gitdate: statement || '' };
    var soc = this;
    chain(function cleanup(err) {
        if (!err)
            return cb && cb.apply(this, arguments);
        soc.disconnect();
        console.log('onceAccessJwt:', err);
        cb && cb.apply(this, Array.from(arguments).map(function (arg, idx, arr) {
            return idx ? arg : arg.toString();
        }));

    }, function () {
        jwt.verify(accessJwt, main.secrets.peerSecret, { algorithms: ['HS256'] }, this);

    }, function (access) {
        soc.locals.access = access;
        access.dialPrefix && (soc.locals.fqdn = access.dialPrefix + '.hq.' + main.secrets.fqdn);
        if (access.larcId)
            larcs.call(soc, statement, this);
        else if (access.scabId)
            scabs.call(soc, this);
        else
            this();

    });
}

function accessJwt(obj) {
    var utc = Date.now() / 1000;
    obj.iat || (obj.iat = utc);
    obj.exp = utc + exports.durationSec;
    return jwt.sign(obj, main.secrets.peerSecret, { algorithm: 'HS256' });
}

process.on('sios', function onSios(sios, filter) { // [], ?function
    if (!Array.isArray(sios))
        throw new Error('sios: array expected for mandatory arg0');
    if (filter && typeof filter !== 'function')
        throw new Error('sios: function expected for optional arg1');

    for (var n in exports.lsnrs)
        for (var id in exports.lsnrs[n].sockets.sockets)
            if (!filter || filter(exports.lsnrs[n].sockets.sockets[id]))
                sios.push(exports.lsnrs[n].sockets.sockets[id]);
});
