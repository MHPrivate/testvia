#! /usr/bin/env node-strict
require('./running'); // generates _process_ 'running' & 'terminate' events
var cio = require('socket.io-client');      // explicit dependency
var debug = require('debug')('mesh.io');    // implicit socket.io dependency
var events = require('events');             // core module
var extend = require('util')._extend;       // core module
var os = require('os');                     // core module
var sio = require('socket.io');             // explicit dependency
var url = require('url');                   // core module

module.exports = exports = Mesh;

// called on receipt of client 'mesh' event - augments server-soc with attr:mesh
function onMesh(peer, uptime) { // _this_ is a Mesh server-side Socket
    debug.apply(null, [this.server ? 'S' : 'C', 'onMesh:'].concat(Array.from(arguments)));
    if (typeof peer !== 'string' || typeof uptime !== 'number') {
        debug('invalid mesh event');
        return this.disconnect();
    }
    if (peer === this.server.mesh.url) { // connection from ourself - discard
        debug('disconnecting ourself');
        return this.disconnect();
    }
    if (process.uptime() < uptime) { // we are younger that the client
        debug('disconnecting older client');
        return this.disconnect();
    }

    // assign _peer_ readonly to the socket mesh object - allows fixup
    Object.defineProperty(this.mesh, 'peer', {
        value: peer,
        writable: false,
    });
    this.mesh.peers[peer] = this; // update attribute of listener {mesh}
    this.mesh.clients.push(this); // update attribute of listener {mesh}

    // arrange for server-side heartbeat to be emitted locally
    this.conn.on('heartbeat', events.prototype.emit.bind(this, 'heartbeat'));

    for (var handler in Mesh.handlers)
        this.on(handler, Mesh.handlers[handler]);
}

Mesh.connection = function onConnection(soc) { // _this_ is a Mesh listener Socket
    debug(soc.server ? 'S' : 'C', 'onConnection:', soc.handshake.address);
    // derive a server-soc specific {mesh} from the listener {mesh}
    Object.defineProperty(soc, 'mesh', { // server-side setup
        configurable: true,
        enumerable: true,
        value: Object.create(soc.server.mesh, { // server-side setup
            client: { configurable: true, enumerable: true, value: false },
            peer: { configurable: true, enumerable: true, writable:true }, // placeholder
            server: { configurable: true, enumerable: true, value: true },
        }),
    });
    soc.once(soc.server.mesh.opts.meshEvent || 'mesh', onMesh);
    soc.conn.once('heartbeat', function () { // cleanup 'mesh' listener if not received by 1st heartbeat
        if (soc.mesh) // valid client 'mesh' event received so no further 'heartbeat' processing here
            return;
        soc.removeListener(soc.server.mesh.opts.meshEvent || 'mesh', mesh);
        debug.enabled && debug.apply(null, [soc.server ? 'S' : 'C', 'onHeartbeat:', soc._eventsCount ? 'retain' : 'disconnect'].concat(Array.from(arguments)));
        soc._eventsCount || soc.disconnect(); // disconnect client unless there are handlers
    });
}

Mesh.handlers = {
 // _this_ is a Socket, client-side has no server-attribute AND server-side has no close-method
    connect: function onConnect() { // only client-side
        debug.enabled && debug.apply(null, [this.server ? 'S' : 'C', 'onConnect:', this.mesh.peer].concat(Array.from(arguments)));
        if (typeof this.mesh.opts.meshUptime === 'number')
            this.emit('mesh', this.mesh.url, this.mesh.opts.meshUptime); // introduce ourselves to the server
        else
            this.emit('mesh', this.mesh.url, process.uptime()); // introduce ourselves to the server
    },
    connect_error: function onConnectError(err) { // only client-side
        debug.enabled
            ? debug.apply(null, [this.server ? 'S' : 'C', 'onConnectError:', this.mesh.peer, err.message])
            : console.log('mesh.io:', this.mesh.peer, err.message);
    },
    disconnect: function onDisconnect(reason) { // both client/server
        debug.enabled && debug.apply(null, [this.server ? 'S' : 'C', 'onDisconnect:', this.mesh.peer].concat(Array.from(arguments)));
        if (this.subs) // will re-establish
            return;
        var idx = this.mesh.clients.indexOf(this);
        ~idx && this.mesh.clients.splice(idx, 1);
        delete this.mesh.peers[this.mesh.peer];
    },
    //heartbeat: function onHeartbeat() { // only server-side - useful for discarding unvalidated clients
    //    debug.enabled && debug.apply(null, [this.server ? 'S' : 'C', 'onHeartbeat:', this.mesh.peer, this.conn.transport.__proto__.constructor.name].concat(Array.from(arguments)));
    //},
};

// called once the listener socket is listening to construct our URL
Mesh.listening = function listening() { // _this_ is a Mesh listener Socket
    this.mesh.url = extend(new url.Url, {
        protocol: this.httpServer.ALPNProtocols ? 'https:' : 'http:',
        slashes: true,
        hostname: this.mesh.opts.meshHostname || os.hostname(),
        port: this.httpServer.address().port,
    }).format();
    debug.enabled && debug.apply(null, ['L', 'listening:', this.mesh.url].concat(Array.from(arguments)));
    return this;
}

// module function - augments a socket.io server with:
//  attr:mesh
//  method:addPeer
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
            close: { configurable: true, enumerable: false, value: lsnr.close },    // prepare to intercept sio:close
            listen: { configurable: true, enumerable: false, value: lsnr.listen },  // prepare to intercept sio:listen
            listener: { configurable: true, enumerable: false, value: lsnr },       // for reference by server/client sockets
            opts: { configurable: true, enumerable: true, value: opts },            // for reference by server/client sockets
            peers: { configurable: true, enumerable: true, value: {} },             // dictionary of peer sockets keyed on their url
        }),
    });
    lsnr.addPeer = addPeer;         // extra method
    lsnr.close = close;             // intercept sio:close
    lsnr.emit2peers = emit2peers;   // extra method
    lsnr.getPeers = getPeers;       // extra method
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

// define a peer - will not persist if this process is older than the peer process
function addPeer(url, opts) { // _this_ is a Mesh listener Socket
    debug.enabled && debug.apply(null, ['L', 'addPeer:'].concat(Array.from(arguments)));
    if (!(this.httpServer || {})._handle)
        throw new Error('addPeer requires Mesh to be running');
    if (!url)
        throw new Error('addPeer requires a url');
    opts = opts || {};

    if (url === this.mesh.url) // silently prevent connection to ourself
        return;
    var soc = this.mesh.peers[url] = this.mesh.peers[url]; // preserve existing where present
    if (soc) // connection already present
        return;

    // connect to the new peer
    soc = this.mesh.peers[url] = cio(url, opts); // socket.io-client module
    debug('client:');
    Object.defineProperty(soc, 'mesh', { // client-side setup
        configurable: true,
        enumerable: true,
        value: Object.create(this.mesh, {
            client: { configurable: true, enumerable: true, value: true },
            opts: { configurable: true, enumerable: true, value: opts },
            peer: { configurable: true, enumerable: true, value: url },
            server: { configurable: true, enumerable: true, value: false },
        }),
    });

    // register core event handlers
    for (var handler in Mesh.handlers)
        soc.on(handler, Mesh.handlers[handler]);

    return soc; // for caller to attach additional _peer_ handlers
}

// monkey patch the close method to cleanly close any peers
function close(/* ... */) { // mesh.io - _this_ is a Mesh listener Socket
    debug.enabled && debug.apply(null, ['L', 'close:'].concat(Array.from(arguments)));
    // clean shutdown has server-peers forget us as we will reconnect on restart
    for (var key in this.mesh.peers)
        if (this.mesh.peers[key].subs) { // active client-side connection to server-peer
            debug('closePeer:', key);
            this.mesh.peers[key].close();
        }
    // server-side connections are closed by the socket.io module
    delete this.mesh.url;
    return this.mesh.close.apply(this, arguments);
}

// send event to all connected peers
function emit2peers(event /* , ... */) {
    debug.enabled && debug.apply(null, ['L', 'emit2peers:'].concat(Array.from(arguments)));
    Object.keys(this.mesh.peers).reduce(function (args, peer, idx, arr) {
        this[peer].emit.apply(this[peer], args);
        return args;
    }.bind(this.mesh.peers), arguments);
}

// return array of peer sockets
function getPeers() {
    return Object.keys(this.mesh.peers).map(function (peer, idx, arr) {
        return this[peer];
    }, this.mesh.peers);
}

// monkey patch the listen to call listening() once the port is allocated
function listen(/* ... */) { // mesh.io - _this_ is a Mesh listener Socket
    debug.enabled && debug.apply(null, ['L', 'listen:'].concat(Array.from(arguments)));
    var retn = this.mesh.listen.apply(this, arguments);
    this.httpServer.on('listening', (this.mesh.opts.meshListening || Mesh.listening).bind(this));
    return retn;
}

/// socket.io event crib-sheet
//    listener: connect
//    listener: connection
//    server: disconnecting
//    server: disconnect
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
//    client: disconnect
//    client: connect_error
//    client: reconnect_attempt
//    client: reconnecting
//    client: reconnect_error
//    client: reconnect_attempt
//    client.io: open
//    client.io: packet
//    client.io: close
