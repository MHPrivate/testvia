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

var bsiaREs = [ // CSL send 4 leading routing digits that are not part of BSIA
    null,   // 00 = 0xCSL + 00xBSIA
    null,   // 01 = 1xCSL + 00xBSIA
    null,   // 02 = 2xCSL + 00xBSIA
    null,   // 03 = 3xCSL + 00xBSIA
    null,   // 04 = 4xCSL + 00xBSIA
    null,   // 05 = 4xCSL + 01xBSIA
    null,   // 06 = 4xCSL + 02xBSIA
    null,   // 07 = 4xCSL + 03xBSIA
    null,   // 08 = 4xCSL + 04xBSIA
    null,   // 09 = 4xCSL + 05xBSIA
    null,   // 10 = 4xCSL + 06xBSIA
    null,   // 11 = 4xCSL + 07xBSIA
    null,   // 12 = 4xCSL + 08xBSIA
    null,   // 13 = 4xCSL + 09xBSIA
    null,   // 14 = 4xCSL + 10xBSIA
    null,   // 15 = 4xCSL + 11xBSIA
    null,   // 16 = 4xCSL + 12xBSIA
    /\d{4}(?<account>\d{4})(?<channels>\d{8})(?<status>\d)$/,   // 17 = 4xCSL + 13xBSIA - NNNNCCCCCCCCS
    /\d{4}(?<account>\d{5})(?<channels>\d{8})(?<status>\d)$/,   // 18 = 4xCSL + 14xBSIA - NNNNNCCCCCCCCS
    /\d{4}(?<account>\d{6})(?<channels>\d{8})(?<status>\d)$/,   // 19 = 4xCSL + 15xBSIA - NNNNNNCCCCCCCCS
    null,   // 20 = 4xCSL + 16xBSIA
    null,   // 21 = 4xCSL + 17xBSIA
    null,   // 22 = 4xCSL + 18xBSIA
    null,   // 23 = 4xCSL + 19xBSIA
    null,   // 24 = 4xCSL + 20xBSIA
    /\d{4}(?<account>\d{4})(?<channels>\d{16})(?<status>\d)$/,   // 25 = 4xCSL + 21xBSIA - NNNNCCCCCCCCCCCCCCCCS
    /\d{4}(?<account>\d{5})(?<channels>\d{16})(?<status>\d)$/,   // 26 = 4xCSL + 22xBSIA - NNNNNCCCCCCCCCCCCCCCCS
    /\d{4}(?<account>\d{6})(?<channels>\d{16})(?<status>\d)$/,   // 27 = 4xCSL + 23xBSIA - NNNNNNCCCCCCCCCCCCCCCCS
    null,   // 28 = 4xCSL + 24xBSIA
    null,   // 29 = 4xCSL + 25xBSIA
    null,   // 30 = 4xCSL + 26xBSIA
    null,   // 31 = 4xCSL + 27xBSIA
    null,   // 32 = 4xCSL + 28xBSIA
    /\d{4}(?<account>\d{4})(?<channels>\d{24})(?<status>\d)$/,   // 33 = 4xCSL + 29xBSIA - NNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /\d{4}(?<account>\d{5})(?<channels>\d{24})(?<status>\d)$/,   // 34 = 4xCSL + 30xBSIA - NNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
    /\d{4}(?<account>\d{6})(?<channels>\d{24})(?<status>\d)$/,   // 35 = 4xCSL + 31xBSIA - NNNNNNCCCCCCCCCCCCCCCCCCCCCCCCS
];

// only open the socket once dependencies are in place - e.g. rpscb
process.running.ready.then(function onReady() {
    var host = os.hostname();
    var svr = main.state.server = net.createServer(function connection(con) { // _this_ is the server
        global.con = con;
        var address = con.remoteFamily === 'IPv6' ? `[${con.remoteAddress}]:${con.remotePort}` : `${con.remoteAddress}:${con.remotePort}`;
        debug(address, 'connected:', new Date);
        con.data = '';
        con.on('data', async function onData(data) { // _this_ is the connection
            con.data += data;
            var raw, msg, match, hr, msgs = con.data.split(/\u0014|\r\n/);
            while (msgs.length > 1) { // for each received message
                msg = (raw = msgs.shift()).replace(/\D/g, ''); // eliminate any non-digits
                match = bsiaREs[msg.length] && bsiaREs[msg.length].exec(msg);// [account,channels,status]
                debug(address, 'MSG:', raw, JSON.stringify(match && match.groups));
                hr = process.hrtime();
                await send(
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
