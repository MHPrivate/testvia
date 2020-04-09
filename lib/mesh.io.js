#! /usr/bin/env node-strict
require('./running'); // generates _process_ 'running' & 'terminate' events
var argsMap = require('./args-map');
var cio = require('socket.io-client');      // explicit dependency
var debug = require('debug')('meshio');     // implicit socket.io dependency
var events = require('events');             // core module
var extend = require('util')._extend;       // core module
var os = require('os');                     // core module
var sio = require('socket.io');             // explicit dependency
var url = require('url');                   // core module

module.exports = exports = Mesh;

Mesh.connection = function onConnection(soc) { // _this_ is a Mesh listener Socket
    debug('onConnection:', soc.id, soc.handshake.address);
    // derive a server-soc specific {mesh} from the listener {mesh}
    Object.defineProperty(soc, 'mesh', { // server-side setup
        configurable: true,
        enumerable: true,
        value: Object.assign(Object.create(soc.server.mesh)),
    });
    soc.conn.once('heartbeat', function () { // _this_ is the engine.io - cleanup if further handlers not added by 1st heartbeat
        debug.enabled && debug.apply(null, ['onceHeartbeat:', soc.id, soc._eventsCount ? 'retain' : 'disconnect'].concat(argsMap(arguments)));
        if (!soc._eventsCount) // no other module has shown interest in messaging from this client - so disconnect
            return soc.disconnect(); // disconnect client unless there are handlers
        soc.server.mesh.clients.push(soc);
        for (var handler in Mesh.handlers)
            soc.on(handler, Mesh.handlers[handler]);
    });
}

Mesh.handlers = { // _this_ is a Socket, client-side has no server-attribute AND server-side has no close-method
    disconnecting: function onDisconnecting(reason) { // string - server
        debug.enabled && debug.apply(null, ['onDisconnecting:', this.id, this.handshake.address].concat(argsMap(arguments)));
        var idx = this.server.mesh.clients.indexOf(this);
        ~idx && this.server.mesh.clients.splice(idx, 1);
    },
};

// called once the listener socket is listening to construct our URL
Mesh.listening = function listening() { // _this_ is a Mesh listener Socket
    this.mesh.url = extend(new url.Url, {
        protocol: this.httpServer.ALPNProtocols ? 'https:' : 'http:',
        slashes: true,
        hostname: this.mesh.opts.meshHostname || os.hostname(),
        port: this.httpServer.address().port,
    }).format();
    debug.enabled && debug.apply(null, ['listening:', this.mesh.url].concat(argsMap(arguments)));
    return this;
}

// module function - augments a socket.io server with:
//  attr:mesh
function Mesh(srv, opts) { // NOT a Constructor
    if ('object' == typeof srv && srv instanceof Object && !srv.listen) {
        opts = srv; // called as Mesh(opts);
        srv = null;
    }
    opts = opts || {};

    var lsnr = sio(srv, opts); // socket.io module
    Object.defineProperty(lsnr, 'mesh', { // listener setup
        configurable: true,
        enumerable: true,
        value: Object.create({}, {
            clients: { configurable: true, enumerable: true, value: [] },           // array of clients of this server
            listen: { configurable: true, enumerable: false, value: lsnr.listen },  // prepare to intercept sio:listen
            listener: { configurable: true, enumerable: false, value: lsnr },       // for reference by server/client sockets
            opts: { configurable: true, enumerable: true, value: opts },            // for reference by server/client sockets
        }),
    });
    lsnr.listen = listen;           // intercept sio:listen

    // register for connection events
    lsnr.on('connection', lsnr.mesh.opts.meshConnection || Mesh.connection);
    if (!lsnr.httpServer) // http/https not yet available
        return lsnr; // enable function chaining
    if (lsnr.httpServer._handle) // http/https is already listening
        return (lsnr.mesh.opts.meshListening || Mesh.listening).apply(lsnr); // enable function chaining

    // otherwise: http/https is available but not yet listening
    lsnr.httpServer.on('listening', (lsnr.mesh.opts.meshListening || Mesh.listening).bind(lsnr));

    return lsnr; // enable function chaining
}

// monkey patch the listen to call listening() once the port is allocated
function listen(/* ... */) { // mesh.io - _this_ is a Mesh listener Socket
    debug.enabled && debug.apply(null, ['listen:'].concat(argsMap(arguments)));
    var retn = this.mesh.listen.apply(this, arguments);
    this.httpServer.on('listening', (this.mesh.opts.meshListening || Mesh.listening).bind(this));
    return retn;
}

/// socket.io event crib-sheet
//    listener: connect
//    listener: connection
//    server: disconnect (after id is removed from soc)
//    server: disconnecting (before id is removed from soc)
//    server.conn: upgrading
//    server.conn: upgrade
//    server.conn: packet
//    server.conn: packeCreate
//    server.conn: flush
//    server.conn: drain
//    server.conn: heartbeat
//    server.conn: close
//    client: connect
//    client: ping
//    client: pong
//    client: disconnect (but NOT disconnecting)
//    client: connect_error
//    client: reconnect_attempt
//    client: reconnecting
//    client: reconnect_error
//    client: reconnect_attempt
//    client.io: open
//    client.io: packet
//    client.io: close
