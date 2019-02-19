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
function mesh(peer, uptime) { // _this_ is a Mesh server-side Socket
    debug.apply(null, [this.server ? 'S' : 'C', 'mesh:'].concat(Array.from(arguments)));
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

    // derive a server-soc specific {mesh} from the listener {mesh}
    Object.defineProperty(this, 'mesh', {
        enumerable: true,
        value: Object.create(this.server.mesh, {
            client: { enumerable: true, value: false },
            peer: { enumerable: true, value: peer },
            server: { enumerable: true, value: true },
        }),
    });
    this.mesh.peers[peer] = this; // update attribute of listener {mesh}
    this.mesh.clients.push(this); // update attribute of listener {mesh}

    // arrange for server-side heartbeat to be emitted locally
    this.conn.on('heartbeat', events.prototype.emit.bind(this, 'heartbeat'));

    for (var i in Mesh.handlers)
        this.on(Mesh.handlers[i].name, Mesh.handlers[i]);
}

Mesh.connection = function connection(soc) { // _this_ is a Mesh listener Socket
    debug.apply(null, [soc.server ? 'S' : 'C', 'connection:'].concat(Array.from(arguments)));
    soc.once(soc.server.mesh.opts.meshEvent || 'mesh', mesh);
    soc.conn.once('heartbeat', function () { // cleanup 'mesh' listener if not received by 1st heartbeat
        if (soc.mesh) // valid client 'mesh' event received so no further 'heartbeat' processing here
            return;
        soc.removeListener(soc.server.mesh.opts.meshEvent || 'mesh', mesh);
        debug.apply(null, [soc.server ? 'S' : 'C', 'heartbeat:', soc._eventsCount ? 'retain' : 'disconnect'].concat(Array.from(arguments)));
        soc._eventsCount || soc.disconnect(); // disconnect client unless there are handlers
    });
}

Mesh.handlers = [ // _this_ is a Socket, client-side has no server-attribute AND server-side has no close-method
    function connect() { // only client-side
        debug.apply(null, [this.server ? 'S' : 'C', 'connect:', this.mesh.peer].concat(Array.from(arguments)));
        if (typeof this.mesh.opts.meshUptime === 'number')
            this.emit('mesh', this.mesh.url, this.mesh.opts.meshUptime); // introduce ourselves to the server
        else
            this.emit('mesh', this.mesh.url, process.uptime()); // introduce ourselves to the server
    },
    function connect_error(err) { // only client-side
        if (debug.enabled)
            debug.apply(null, [this.server ? 'S' : 'C', 'connect_error:', this.mesh.peer, err.message]);
        else
            console.log('mesh.io:', this.mesh.peer, err.message);
    },
    function disconnect(reason) { // both client/server
        debug.apply(null, [this.server ? 'S' : 'C', 'disconnect:', this.mesh.peer].concat(Array.from(arguments)));
        if (this.subs) // will re-establish
            return;
        var idx = this.mesh.clients.indexOf(this);
        ~idx && this.mesh.clients.splice(idx, 1);
        delete this.mesh.peers[this.mesh.peer];
    },
    function heartbeat() { // only server-side - useful for discarding unvalidated clients
        debug.apply(null, [this.server ? 'S' : 'C', 'heartbeat:', this.mesh.peer, this.conn.transport.__proto__.constructor.name].concat(Array.from(arguments)));
    },
];

// called once the listener socket is listening to construct our URL
Mesh.listening = function listening() { // _this_ is a Mesh listener Socket
    this.mesh.url = extend(new url.Url, {
        protocol: this.httpServer.ALPNProtocols ? 'https:' : 'http:',
        slashes: true,
        hostname: this.mesh.opts.meshHostname || os.hostname(),
        port: this.httpServer.address().port,
    }).format();
    debug.apply(null, ['L', 'listening:', this.mesh.url].concat(Array.from(arguments)));
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

    var self = sio(srv, opts); // socket.io module
    Object.defineProperty(self, 'mesh', {
        enumerable: true,
        value: Object.create({}, {
            clients: { enumerable: true, value: [] },           // array of clients of this server
            close: { enumerable: false, value: self.close },    // prepare for monkey patching below
            listen: { enumerable: false, value: self.listen },  // prepare for monkey patching below
            listener: { enumerable: false, value: self },       // for reference by server/client sockets
            opts: { enumerable: true, value: opts },            // for reference by server/client sockets
            peers: { enumerable: true, value: {} },             // dictionary of peer sockets keyed on their url
        }),
    });
    self.addPeer = addPeer;         // extra method
    self.close = close;             // monkey patched method
    self.emit2peers = emit2peers;   // extra method
    self.getPeers = getPeers;       // extra method
    self.listen = listen;           // monkey patched method

    // register for connection events
    self.on('connection', self.mesh.opts.meshConnection || Mesh.connection);
    if (!self.httpServer) // http/https not yet available
        return self; // enable function chaining
    if (self.httpServer._handle) // http/https is already listening
        return (self.mesh.opts.meshListening || Mesh.listening).apply(self); // enable function chaining

    // otherwise: http/https is available but not yet listening
    self.httpServer.on('listening', (self.mesh.opts.meshListening || Mesh.listening).bind(self));

    return self; // enable function chaining
}

// define a peer - will not persist if this process is older than the peer process
function addPeer(url, opts) { // _this_ is a Mesh listener Socket
    debug.apply(null, ['L', 'addPeer:'].concat(Array.from(arguments)));
    if (!(this.httpServer || {})._handle)
        throw new Error('addPeer requires Mesh to be running');
    if (!url)
        throw new Error('addPeer requires a url');
    opts = opts || {};

    if (url === this.mesh.url) // silently prevent connection to ourself
        return this; // enable function chaining
    var soc = this.mesh.peers[url] = this.mesh.peers[url]; // preserve existing where present
    if (soc) // connection already present
        return this; // enable function chaining

    // connect to the new peer
    soc = this.mesh.peers[url] = cio(url, opts); // socket.io-client module
    Object.defineProperty(soc, 'mesh', {
        enumerable: true,
        value: Object.create(this.mesh, {
            client: { enumerable: true, value: true },
            opts: { enumerable: true, value: opts },
            peer: { enumerable: true, value: url },
            server: { enumerable: true, value: false },
        }),
    });

    // register core event handlers
    for (var i in Mesh.handlers)
        soc.on(Mesh.handlers[i].name, Mesh.handlers[i]);

    return soc; // caller to attach additional _peer_ handlers
}

// monkey patch the close method to cleanly close any peers
function close(/* ... */) { // mesh.io - _this_ is a Mesh listener Socket
    debug.apply(null, ['L', 'close:'].concat(Array.from(arguments)));
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
    debug.apply(null, ['L', 'emit2peers:'].concat(Array.from(arguments)));
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
    debug.apply(null, ['L', 'listen:'].concat(Array.from(arguments)));
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
