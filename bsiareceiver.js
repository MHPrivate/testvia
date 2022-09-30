#! /usr/bin/env -S node-strict  --

// messaging between receivers & bridges
// =====================================
//      receiver                                bridge(s)
//      ========                                =========
//      [startup] ----------------------------> bsia:bridges({host}, cb) => cb({buid, host, weight})
//      bsia:receivers({buid, host, weight}) <- [startup]
//      [message] ----------------------------> bsia:<buid>({host, account, channels, status}, cb) => cb(success)

//process.env.DEBUG || (process.env.DEBUG = 'bsiareceiver');
require('./lib/running').running = undefined; // causes main.running set _true_ once running AND _false_ when terminating
require('./lib/repletion')({ processGlobal: true, always: !process.stdin.isTTY }); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)

var debug = require('debug')('bsiareceiver'),
    net = require('net'),
    os = require('os'),
    rpscb = require('./lib/rpscb');
    
var main = Object.defineProperties(Object.assign(exports,  {
    cache: {},      // slow-dynamic runtime context - e.g. SSL certificate(s)
    config: {},     // static global settings that are common between multiple instances on the same host
    control: {},    // dynamic runtime settings that broadly vary behaviour e.g. on/off site
    debug: require('debug'),    // for logging module administration
    global: global, // expose process global for repl-client connections
    hack: {},       // diagnostic runtime settings - usually empty
    modules: {      // container for loadable functionality modules
        rpscb: rpscb,
    },
    secrets: require('./secrets.json'),
    setup: {},      // static instance settings variations that allow multiple instances on the same host e.g. port numbers
    state: {        // fast-dynamic runtime context for detail tracking
        bridges: {}, // buid => {weight, used} // weights 0..3: disabled, deferred, normal, preferred
        server: undefined, // net.Server
    },
    uuidv1: null,   // will be require('uuid').v1 bound to the primary system mac-address
}), {
    cluster: { enumerable: false },
    debug: { enumerable: false },
    global: { enumerable: false },
    modules: { enumerable: false },
    secrets: { enumerable: false },
});

process.running.then(function onLoaded() {
    // probe for available Bridges to service received BSIA messages
    rpscb.publish('bsia:bridges', { host: os.hostname() }, function onBsiaBridgesCb(err, outs, bridge) {
        err ? debug('onBsiaBridgesCb:', err) : debug('onBsiaBridgesCb:', outs, bridge ? JSON.stringify(bridge) : '');
        if (!bridge)
            null;
        else if (bridge.weight > 0)
            main.state.bridges[bridge.buid] = Object.assign(bridge, { used: new Date });
        else
            delete main.state.bridges[bridge.buid];
    });

    // received announcement of a Bridge availability
    rpscb.on('bsia:receivers', function onBsiaReceivers(bridge) {
        debug('onBsiaReceiversCb:', JSON.stringify(bridge));
        if (!bridge)
            null;
        else if (bridge.weight > 0)
            main.state.bridges[bridge.buid] = Object.assign(bridge, { used: new Date });
        else
            delete main.state.bridges[bridge.buid];
    });
});

var bsiaREs = [
    null,   // 00
    null,   // 01
    null,   // 02
    null,   // 03
    null,   // 04
    null,   // 05
    null,   // 06
    null,   // 07
    null,   // 08
    null,   // 09
    null,   // 10
    null,   // 11
    null,   // 12
    /(?<account>\d{4})(?<channels>\d{8})(?<status>\d)$/,   // 13 - NNNNCCCCCCCCS
    /(?<account>\d{5})(?<channels>\d{8})(?<status>\d)$/,   // 14 - NNNNNCCCCCCCCS
    /(?<account>\d{6})(?<channels>\d{8})(?<status>\d)$/,   // 15 - NNNNNNCCCCCCCCS
    /(?<account>\d{7})(?<channels>\d{8})(?<status>\d)$/,   // 16 - NNNNNNNCCCCCCCCS
    /(?<account>\d{8})(?<channels>\d{8})(?<status>\d)$/,   // 17 - NNNNNNNNCCCCCCCCS
    /(?<account>\d{9})(?<channels>\d{8})(?<status>\d)$/,   // 18 - NNNNNNNNNCCCCCCCCS
    null,   // 19
    null,   // 20
    /(?<account>\d{4})(?<channels>\d{16})(?<status>\d)$/,   // 21 - NNNNCCCCCCCCCCCCCCCCS
    /(?<account>\d{5})(?<channels>\d{16})(?<status>\d)$/,   // 22 - NNNNNCCCCCCCCCCCCCCCCS
    /(?<account>\d{6})(?<channels>\d{16})(?<status>\d)$/,   // 23 - NNNNNNCCCCCCCCCCCCCCCCS
    /(?<account>\d{7})(?<channels>\d{16})(?<status>\d)$/,   // 24 - NNNNNNNCCCCCCCCCCCCCCCCS
    /(?<account>\d{8})(?<channels>\d{16})(?<status>\d)$/,   // 25 - NNNNNNNNCCCCCCCCCCCCCCCCS
    /(?<account>\d{9})(?<channels>\d{16})(?<status>\d)$/,   // 26 - NNNNNNNNNCCCCCCCCCCCCCCCCS
    null,   // 27
    null,   // 28
    /(?<account>\d{4})(?<channels>\d{24})(?<status>\d)$/,   // 29 - NNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /(?<account>\d{5})(?<channels>\d{24})(?<status>\d)$/,   // 30 - NNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /(?<account>\d{6})(?<channels>\d{24})(?<status>\d)$/,   // 31 - NNNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /(?<account>\d{7})(?<channels>\d{24})(?<status>\d)$/,   // 32 - NNNNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /(?<account>\d{8})(?<channels>\d{24})(?<status>\d)$/,   // 33 - NNNNNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /(?<account>\d{9})(?<channels>\d{24})(?<status>\d)$/,   // 34 - NNNNNNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
];

// only open the socket once dependencies are in place - e.g. rpscb
process.running.ready.then(function onReady() {
    var host = os.hostname();
    var svr = main.state.server = net.createServer(function connection(con) { // _this_ is the server
        global.con = con;
        var address = con.remoteFamily === 'IPv6' ? `[${con.remoteAddress}]:${con.remotePort}` : `${con.remoteAddress}:${con.remotePort}`;
        debug(address, 'connected:', new Date);
        con.data = '';
        con.on('data', function onData(data) { // _this_ is the connection
            con.data += data;
            var raw, msg, match, hr, msgs = con.data.split(/\u0014|\r\n/);
            while (msgs.length > 1) { // for each received message
                msg = (raw = msgs.shift()).replace(/\D/g, ''); // eliminate any non-digits
                match = bsiaREs[msg.length] && bsiaREs[msg.length].exec(msg);// [account,channels,status]
                debug(address, 'MSG:', raw, JSON.stringify(match && match.groups));
                hr = process.hrtime();
                send(
                    Object.defineProperty((match || { groups: {} }).groups, 'address', { value: address })
                ).then(function (result) {
                    console.log(address, 'ACK:', raw, result, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms', new Date);
                    con.write('\u0006'); // ACK
                }).catch(function (err) {
                    console.log(address, 'NAK:', raw, err, process.hrtime(hr).reduce(function (w, n, i, a) { return w = w * 1000000000 + n }, 0) / 1000000 + 'ms', new Date);
                    con.write('\u0015'); // NAK
                });
            }
            con.data = msgs.shift();
            
        }).on('error', function onError(err) { // _this_ is the connection
            console.error('socket:', err);
            this.end();

        }).on('end', function onEnd() { // _this_ is the connection
            debug(address, 'disconnected:', new Date);

        }).setEncoding('ascii');
        
    }).listen(((main.secrets.bsia || {})[host] || {}).port || 4200, function listening() { // _this_ is the server
        var address = this.address();
        debug(address.family === 'IPv6' ? `[${address.address}]:${address.port}` : `${address.address}:${address.port}`, 'listening', new Date);

    });
    process.once('terminate', function _bsiareceiver() {
        debug('terminate');
        main.state.server = svr.close() && undefined;
        
    });
});

function send(groups) {
    debug(groups.address, 'SND:', JSON.stringify(groups));
    if (!groups.account) // invalid message
        return Promise.reject('invalid message');

    var attempted = {}; // list of bridges that declined
    return new Promise(function attempt(resolved, rejected) {
        var bridge, bridges = main.state.bridges;
        for (var buid in bridges) {
            if (buid in attempted) // bridge already declined this message 
                null;
            else if (!bridge) // 1st candidate - best so far
                bridge = bridges[buid];
            else if (bridge.weight < bridges[buid].weight) // candidate has a preferred weighting - best so far
                bridge = bridges[buid];
            else if (bridge.weight > bridges[buid].weight) // candidate has a deferred weighting - skip
                null;
            else if (bridge.used > bridges[buid].used) // candidate is least-recent used in given weighting
                bridge = bridges[buid];
        }
        if (!bridge) // no available bridge
            return rejected('no available bridge');

        attempted[bridge.buid] = bridge.used = new Date;
        var responders = 0, success = false;
        rpscb.publish(1000, `bsia:${bridge.buid}`, {
            host: os.hostname(),
            account: groups.account,
            channels: groups.channels,
            status: groups.status,
        }, function(err, outs, accepted) {
            err ? debug(groups.address, `bsia:${bridge.buid}:`, err) : debug(groups.address, `FWD: ${bridge.host} bsia:${bridge.buid}:`, outs, accepted);
            responders += +(arguments.length > 2) // bridge response
            success = success || accepted;

            if (accepted) // accepted by responding bridge
                return resolved('sent');

            if (!outs && !responders) // non-existent bridge
                delete bridges[bridge.buid]; // discard from dictionary

            if (!outs && !success) // bridge attempt failed
                return attempt(resolved, rejected); // recursion attempt to another bridge

        });
    });
}
