#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var debug = require('debug')('redis:proxyConfig');
var dns = require('dns');
var main = require.main.exports;
var mysql = require('../mysql');
var os = require('os');
var rpscb = require('../rpscb');
var url = require('url');

// Configuration values
//      fqdn:port       - proxy assignment
//      fqdn            - alias for fqdn:443
//      <empty-string>  - de-proxy
//      NULL            - do-nothing

// Functional Overview
//
//  This module monitors LARC connectivity and proxy-config updates to send re-proxy invites when needed
//      - any new LARC master connection, announced via process:larcMaster, is checked to see that it belongs
//      on the local service. if it does not belong, all peers are sent a rpscb:proxyCheck for that scheme
//      - any changes to sql-database proxy-config, announced via process:proxyConfig, harvests,
//      packages and sends an rpscb:proxyUpdate to all peers (including itself)
//      - every peer receives the rpscb:proxyUpdate and each mis-connected LARC master connection sees a
//      rpscb:proxyCheck for that scheme sent to all peers (including itself)
//      - every peer receives the rpscb:proxyCheck, and where it is the intended proxy, sends a re-proxy
//      invite to the scheme via its master LARC
//
// Handlers
//  process:larcMaster(master, soc)
//      sent by LARC connectivity management when the master/standby condition is available
//      - send rpscb:proxyCheck to all peers if the LARC should be connected to a different service
//
//  process:proxyConfig
//      sent on service startup and explicitly following a database-update to the proxy-configuration
//      - harvests the current proxy configuration and shares to all peers via an rspcb:proxyUpdate
//      - this config sharing eliminates the need for each peer to independently harvest the database
//
//  rpscb:proxyUpdate(proxy-configuration)
//      sent by a peer following a database-update to proxy-configuration
//      - updates an internal cache of IP addresses for hostnames referenced in the proxy-configuration
//      - sends rpscb:proxyCheck to all peers for any mis-connected LARC masters
//
//  rpscb:proxyCheck({ dialPrefix, proxyActual, proxyConfig, schemeId })
//      sent by peers to provoke the intended proxy to invite the LARC to re-proxy
//      - skips further processing if the given LARC should be connected to a different service instance
//      - acquires the sipPassword for the associated scheme and send a larc:proxy({ appHostPort, sipHostPort, sipPassword })
//      - NOTE: re-proxy requests are only sent by the intended service ensuring its availability
//

module.exports = exports = Object.assign(onProxyConfig, {
    prefixFqdnPorts: {},
    hostIPs: {},
    minHQ: new Date('2020-04-08T10:22:35.000Z'), // earliest that delivers master/standby alongside accessJwt
    url: undefined,
});

// helper function
function prefixFqdnPort(dialPrefix) {
    var longestPrefix = '';
    for (var prefix in exports.prefixFqdnPorts) // find longest prefix match
        if (!dialPrefix.startsWith(prefix))
            continue;
        else if (prefix.length < longestPrefix.length)
            continue;
        else
            longestPrefix = prefix;
    return exports.prefixFqdnPorts[longestPrefix];
}

// local notification of a master connection - allow intended proxy to initiate a connectivity change
process.on('larcMaster', function onLarcMaster(master, soc) { // ?boolean, Socket: { locals: { ?fqdn,ip,?ipv4,ipv6,access:{iat,exp,larcId,name,?dialPrefix,?schemeId} } }
    debug.enabled && debug.apply(0, ['onLarcMaster:'].concat(argsMap(arguments)));

    // ignore any larcMaster events for standby LARCs or LARCs with no scheme
    var locals = { dialPrefix: soc.locals.access.dialPrefix, prefix: '', ips: new Set};
    if (!master || !locals.dialPrefix || (locals.gitdate < exports.minHQ)) // not-master OR has no scheme OR HQ version too old
        return debug.enabled && debug('onLarcMaster: ignore', JSON.stringify({ master: master, dialPrefix: locals.dialPrefix }));

    // establish configured proxy allegence for this master LARC
    locals.fqdnPort = prefixFqdnPort(locals.dialPrefix); // find longest prefix match
    locals.url = locals.fqdnPort && new url.URL('https://' + locals.fqdnPort);

    // ignore any master LARCs with no configured proxy allegence
    var hostIPs = exports.hostIPs[(locals.url || {}).hostname];
    debug('onLarcMaster:', (locals.url || {}).hostname, hostIPs);
    if (!locals.url || !exports.hostIPs[locals.url.hostname]) // no-match OR null-match OR no-IPs
        return debug.enabled && debug('onLarcMaster: skip', JSON.stringify({ dialPrefix: locals.dialPrefix, fqdnPort: locals.fqdnPort, ips: hostIPs }));

    // provoke a peer service to invite the master LARC to switch allegence
    rpscb.publish('proxyCheck', Object.assign({
        proxyActual: exports.url.hostname + ':' + (exports.url.port || '443'),
        proxyConfig: locals.url.hostname + ':' + (locals.url.port || '443'),
    }, soc.locals.access));
});

mysql.running.then(onProxyConfig); // startup trigger to load current proxyConfig
process.on('proxyConfig', onProxyConfig);
function onProxyConfig(cb) { // local trigger to publish the latest proxyConfig
    debug.enabled && debug.apply(0, ['onProxyConfig:'].concat(argsMap(arguments)));
    if (typeof cb !== 'function') // could be a Promise
        cb = function (err) { err && console.log('onProxyConfig:', err) };
    cb.index = 'proxyConfig:';
    var locals = {};
    chain(cb, function () {
        mysql(locals.sql = 'select * from config where schemeId=0 and nameSlashed like "/proxy/%" order by nameSlashed', this);

    }, function (configs, meta) { // [{id,nameSlashed,schemeId,touched,valueNumber,valueString,visibilityScheme}, ...]
        locals.configs = configs
        configs.forEach(function (config, idx, arr) {
            if (!config.valueString)
                return this[config.nameSlashed.slice(7)] = config.valueString; // null or empty-string
            try {
                var _url = new url.URL('https://' + config.valueString);
                this[config.nameSlashed.slice(7)] = _url.hostname + ':' + (_url.port || '443');
            } catch (ex) { }
        }, locals.prefixFqdnPorts = {});

        locals.rpscb = rpscb.publish('proxyUpdate', locals.prefixFqdnPorts);
        this(null, locals); // supply locals for optional diagnostic inspection

    });
}

// received from peers to update the active proxyPrefixes table
rpscb.on('proxyUpdate', function onProxyUpdate(prefixFqdnPorts) { // { prefix: fqdn:port, ... }
    debug.enabled && debug.apply(0, ['onProxyUpdate:'].concat(argsMap(arguments)));
    if (!exports.url)
        exports.url = new url.URL('https://' + os.hostname() + ':' + (process.env.PORT || '8443'));

    exports.prefixFqdnPorts = prefixFqdnPorts; // { prefix=>hostname:port, ... }
    var hostnames = new Set([exports.url.hostname]);
    for (var prefix in prefixFqdnPorts) // create a set of hostnames to resolve
        if (prefixFqdnPorts[prefix])
            try {
                debug('onProxyUpdate: hostname', prefixFqdnPorts[prefix]);
                hostnames.add(new url.URL('https://' + (prefixFqdnPorts[prefix] || '')).hostname);
            } catch (ex) { }

    var pending = 0; // a count of pending dns-lookups
    hostnames.forEach(function (hostname, idx, arr) { // regenerate cache of IPs for each hostname
        ++pending;
        dns.lookup(hostname, { all: true }, function (err, addresses) {
            exports.hostIPs[this] = (addresses || []).map(function (address, idx, arr) {
                return address.address;
            });
            if (--pending) // further resolves still pending
                return;

            // collate a list of fqdnPorts psuedonyms for the current service process
            var localIPs = exports.hostIPs[exports.url.hostname], psuedonyms = new Set;
            for (var hostname in exports.hostIPs)
                for (var n in exports.hostIPs[hostname])
                    if (localIPs.includes(exports.hostIPs[hostname][n]))
                        psuedonyms.add(hostname + ':' + exports.url.port);
            debug('onProxyUpdate:', JSON.stringify({ psuedonyms: Array.from(psuedonyms) }));

            // survey the current set of LARC client connections for any that need re-proxying
            var sios;
            process.emit('sios', sios = [], function (sio) {
                return sio && sio.locals && sio.locals.master && (sio.locals.access || {}).dialPrefix && (sio.locals.gitdate >= exports.minHQ);
            });
            var deproxyHost = (main.secrets.functionalBlocks.deproxyFqdns || []).includes(exports.url.hostname);
            deproxyHost && debug('onProxyUpdate: deproxyHost');
            for (var n in sios) {
                var fqdnPort = prefixFqdnPort(sios[n].locals.access.dialPrefix);
                if (fqdnPort === '') { // '' means de-proxy, null mean do-nothing
                    if (deproxyHost)
                        null;
                    else if (main.secrets.functionalBlocks.autoProxy)
                        console.log('BLOCKED: autoProxy:', sios[n].locals.access.dialPrefix, undefined);
                    else
                        sios[n].emit('proxy');
                } else if (fqdnPort && !psuedonyms.has(fqdnPort)) { // should be connected to a different service
                    rpscb.publish('proxyCheck', Object.assign({
                        proxyActual: exports.url.hostname + ':' + (exports.url.port || '443'),
                        proxyConfig: fqdnPort,
                    }, sios[n].locals.access));
                }
            }
        }.bind(hostname));
    });
});

// received from peers - notification of LARC connect/disconnect
rpscb.on('proxyCheck', function onProxyCheck(data) { // {dialPrefix,proxyActual,proxyConfig,schemeId}
    debug.enabled && debug.apply(0, ['onProxyCheck:'].concat(argsMap(arguments)));

    var locals = Object.assign(data, {
        actualUrl: new url.URL('https://' + data.proxyActual),
        configUrl: new url.URL('https://' + data.proxyConfig),
    });
    Object.assign(locals, {
        actualIPs: exports.hostIPs[locals.actualUrl.hostname] || [], // should be non-empty if we are the actual server
        configIPs: exports.hostIPs[locals.configUrl.hostname] || [], // should be non-empty for whatever config server
        ifaces: os.networkInterfaces(),
    });

    // check if LARC should be proxied to another server machine
    config: for (var iface in locals.ifaces)
            for (var n = 0; n < locals.ifaces[iface].length; ++n)
                if (locals.configIPs.includes(locals.ifaces[iface][n].address))
                    break config;
    debug.enabled && debug('onProxyCheck: config', JSON.stringify({ iface: iface, n: n, configIPs: locals.configIPs }));
    if (!locals.ifaces[iface][n] || locals.configUrl.port !== exports.url.port)
        return debug('onProxyCheck: no action for this service');

    // check if LARC is already proxied to this service process
    actual: for (var iface in locals.ifaces)
            for (var n = 0; n < locals.ifaces[iface].length; ++n)
                if (locals.actualIPs.includes(locals.ifaces[iface][n].address))
                    break actual;
    debug.enabled && debug('onProxyCheck: actual', JSON.stringify({ iface: iface, n: n, actualIPs: locals.actualIPs }));
    if (locals.ifaces[iface][n] && locals.actualUrl.port === exports.url.port)
        return debug('onProxyCheck: currently connected to this service');

    // send invite from LARC proxy re-configure
    chain(function cleanup(err, feedback) {
        err && console.log('onProxyCheck:', err);

    }, function () {
        this.index = 'proxyCheck';
        mysql('select * from sipUsers where user=? and name="password" and scope="user" and type="param"', [data.dialPrefix], this);

    }, function (schemes, meta) {
        if (!schemes.length)
            return debug('onProxyCheck: no sipPassword', locals.dialPrefix) || this();

        var data = {
            appHostPort: locals.configUrl.hostname + ':' + (locals.configUrl.port || '443'),
            sipHostPort: locals.configUrl.hostname + ':5071',
            sipPassword: schemes[0].value,
        };
        if (main.secrets.functionalBlocks.autoProxy)
            console.log('BLOCKED: autoProxy', locals.dialPrefix, JSON.stringify(data));
        else
            rpscb.publish('scheme:' + locals.schemeId, 'proxy', data);
        return this();

    });
});
