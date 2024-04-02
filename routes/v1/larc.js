var basic = require('basic-auth');
var chain = require('scope-chain');
var express = require('express');
var extend = require('node.extend');
var passwordGenerator = require('password-generator');
var ipaddr = require('ipaddr.js');
var ipv4fqdn = require('../../lib/ipv4fqdn');
var main = require.main.exports;
var mesh = require('../../lib/mesh');
var mosh = require('../../lib/mosh');
var mysql = require('../../lib/mysql');
var nsupdate = require('../../lib/nsupdate');
var os = require('os');
var uuidv4 = require('uuid/v4');

module.exports = exports = express.Router();

exports.post('/', function (req, res, next) { // POST /larc - create/update larc entry
    // expects: Authorization: Basic base64(HEX16:HEX32) with body = { githash, ipv4, ipv6, mac }
    //  name(HEX16) taken from /proc/cpuinfo:Serial - RaspberryPi-serialNo
    //  pass(HEX32) taken from /sys/block/mmcblk0/device/cid  - SDcard-cid
    //  githash captured from 'git rev-parse HEAD'
    //  ipv4 taken from eth0 as private address
    //  ipv6 taken from eth0 as public address
    //  mac taken from eth0
    var locals = Object.assign(req.locals, {
        credentials: basic(req),
        sqls: [], // queued inserts/updates
    });
    if (locals.credentials.name.length !== 16 || locals.credentials.pass.length !== 32)
        return next();

    // do the create/update
    console.log('larc:', locals.credentials.name, JSON.stringify(req.body));
    next.index = req.index;
    chain(next, function () {
        chain(this, function () {
            locals.ipv4i = req.body.ipv4 && ipaddr.IPv4.parse(req.body.ipv4).toString();
            locals.ipv4v = req.body.vipv4 && ipaddr.IPv4.parse(req.body.vipv4).toString();
            if (!locals.ipv4i) // validate the private IPv4
                return this('route');
            mysql('select * from larcs where (username=? and password=?) or id=0 order by id', [locals.credentials.name, locals.credentials.pass], this);

        }, function (larcs, meta) { // prepare the database row
            locals.larcs = larcs;
            larcs = larcs.filter(function (larc, idx, arr) { // rows 0 & n (two rows)
                if (!larc.id) // learn the gitdate from rowId#0 if present
                    locals.gitdate = larc.gitdate;
                return larc.id;
            });
            locals.ipv6 = ipaddr.IPv6.parse(req.ip);
            var larc = {
                created: larcs.length ? undefined : req._startTime, // existing or new LARC
                gitbranch: req.body.gitbranch,
                gitdate: req.body.gitdate && new Date(req.body.gitdate),
                githash: req.body.githash,
                ipv4i: locals.ipv4i,
                ipv4x: locals.ipv6.isIPv4MappedAddress() ? locals.ipv6.toIPv4Address().toString() : undefined,
                ipv6: req.body.ipv6,
                jsonConfigIds: null, // reset be each ping request
                master: req.body.master,
                nodejs: req.body.nodejs,
                password: locals.credentials.pass,
                sdBroken: (larcs[0] || {}).sdBroken,
                sdCheckpoint: req.body.sdCheckpoint && new Date(req.body.sdCheckpoint),
                seen: req._startTime,
                started: req.body.started && new Date(req.body.started),
                upgrade: req.body.githash ? 0 : undefined, // reset by each ping request containing a githash
                username: locals.credentials.name,
            };
            if (larcs.length) {
                if (larcs[0].sdBroken) // already broken - no change
                    null;
                else if (larcs[0].sdCheckpoint && !larc.sdCheckpoint) // previously reported but not this time suggests HQ rollback
                    larc.sdBroken = 1;
                else if (larcs[0].sdCheckpoint > larc.sdCheckpoint) // previously reported a later date
                    larc.sdBroken = 1;
                locals.upgrade = larcs[0].upgrade && req.body.githash;
                locals.jsonConfigIds = larcs[0].jsonConfigIds ? larcs[0].jsonConfigIds.split(/,\s*/) : [];
            } else {
                locals.jsonConfigIds = [];
            }
            if (!locals.upgrade) // larc-row not calling for upgrade - check GA release
                locals.upgrade = +(larc.gitdate < locals.gitdate); // upgrade where larc predates GA
            mysql(mysql.mksql('larcs', larc, larcs[0]), this); // insert/update the database row
            locals.larc = larcs[0] || larc;

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
            if (status.insertId) // record the rowId from an insert
                locals.larc.id = status.insertId;
            locals.noChange = true;

            // check the internal IPv4 address is in the DNS
            nsupdate.fqdnCheck(ipv4fqdn(locals.ipv4i), 'a', locals.ipv4i, this);

        }, function (cert, privkey, chain, noChange) { // check internal shared DNS name
            locals.noChange = locals.noChange && noChange;
            this();

        });

    }, function () {
        if (!locals.ipv4v)
            return this();

        chain(this, function () {
            // check the shared IPv4 address is in the DNS
            nsupdate.fqdnCheck(ipv4fqdn(locals.ipv4v), 'a', locals.ipv4v, this);

        }, function (cert, privkey, chain, noChange) {
            locals.noChange = locals.noChange && noChange;
            this();

        });

    }, function () { // fetch the associated scheme - if known
        chain(this, function () {
            mysql('select * from schemes where id=?', [locals.larc.schemeId], this);

        }, function (schemes, meta) { // assign a scheme secret if blank
            var scheme = {};
            locals.scheme = schemes[0];
            if (!locals.larc.ipv4x || !locals.scheme)
                return this.this();

            if (!locals.scheme.secret)
                scheme.secret = uuidv4();
            if (locals.scheme.live && (locals.larc.gitbranch || 'master') !== 'master')
                scheme.live = 0;
            if (Object.keys(scheme).length)
                locals.sqls.push(mysql.mksql('schemes', scheme, locals.scheme));
            mysql('select * from sipUsers where scope="user" and user=?', [locals.scheme.dialPrefix], this);

        }, function (sipUsers, meta) {
            locals.sipUsers = sipUsers;
            var missing = [ // rows
                { scope: 'user', type: 'group', name: 'schemes', value: '' },
                { scope: 'user', type: 'param', name: 'password', value: passwordGenerator(32, false, /\w/, '') },
                { scope: 'user', type: 'variable', name: 'effective_caller_id_name', value: locals.scheme.scheme },
            ].reduce(function (wksp, row, idx, arr) { // transformed to dictionary of type:name => row
                return wksp.set(row.type + ':' + row.name, row);
            }, new Map);
            locals.sipUsers.forEach(function (sipUser, idx, arr) { // strip-out existing dictionary entries
                this.delete(sipUser.type + ':' + sipUser.name);
            }, missing);
            missing.forEach(function (row, key, map) {
                this.push(mysql.mksql('sipUsers', Object.assign({ user: locals.scheme.dialPrefix }, row)));
            }, locals.sqls);
            this();

        });

    }, function () { // check the public DNS name
        if (!locals.scheme || !locals.larc.ipv4x)
            return this();

        chain(this, function () { // check the public DNS name
            // check the external IPv4 address is in the DNS
            locals.fqdn = locals.scheme.dialPrefix + '.hq.' + main.secrets.fqdn;
            nsupdate.fqdnCheck(locals.fqdn, 'a', locals.larc.ipv4x, this);

        }, function (cert, privkey, chain, noChange) { // apply pending DNS updates from the database
            locals.noChange = locals.noChange && noChange;
            locals.cert = cert;
            locals.privkey = privkey;
            locals.chain = chain;
            if (!locals.scheme || !locals.larc.ipv4x)
                return this();
            nsupdate.fqdnCheck(locals.scheme.dialPrefix + '.ua.' + main.secrets.fqdn, 'cname', locals.fqdn, this);

        }, function (cert, privkey, chain, noChange) { // apply pending DNS updates from the database
            nsupdate.flush(this);

        });

    }, function () { // process jsonConfigIds if present
        /// the following two lines of general site fragments must not be used with HQ versions before gitdate '2018-04-22 09:25:20' GMT
        //if (!((locals.scheme || {}).dialPrefix || '').startsWith('40199')) // don't auto-interfere with config on test-rigs
        //    locals.jsonConfigIds.unshift((locals.scheme || {}).live ? 1 : -1); // deliver live/non-live config fragment (usually mailto only)
        if (((locals.scheme || {}).dialPrefix || '') === '4019901') // only auto-interfere with config on wrinkly
            locals.jsonConfigIds.unshift(2); // deliver live/non-live config fragment (usually mailto only)
        if (!locals.jsonConfigIds.length)
            return this();

        chain(this, function () {
            mysql('select * from jsonConfigs where id in (' + mysql.qmks(locals.jsonConfigIds) + ')', locals.jsonConfigIds, this);

        }, function (jsonConfigs, meta) { // merge config fragments in order
            if (!jsonConfigs)
                return this();
            jsonConfigs = jsonConfigs.reduce(function (wksp, jsonConfig, idx, arr) {
                wksp[jsonConfig.id] = JSON.parse(jsonConfig.json);
                return wksp;
            }, {});
            this(null, locals.jsonConfigIds.reduce(function (wksp, id, idx, arr) {
                return this[id] ? extend(true, wksp, this[id]) : wksp; // deep merge
            }.bind(jsonConfigs), {}));

        }, function (config) { // consider requesting a mosh session
            locals.config = req.body.master && config;
            this();
        });

    }, function () {
        chain(this, function () {
            mosh.larc(locals.larc.mosh && req.ip, this);

        }, function (moshPort) {
            locals.moshPort = moshPort;
            this();

        });

    }, function () {
        if (!locals.scheme || locals.scheme.nocdrs)
            return this();

        chain(this, function () {
            mysql('select * from schemeCdrs where schemeId=? order by started desc, id desc limit 1', [locals.scheme.id], this);

        }, function (cdrs, meta) {
            locals.lastCdrMs = !cdrs ? null : !cdrs[0] ? 0 : JSON.parse(cdrs[0].json).startUtcMs; // null means disabled
            this();
        });

    }, function loop() {
        if (!locals.sqls.length)
            return this();

        chain(this, function () {
            mysql(locals.sqls.shift(), this);

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
            loop.call(this.this);

        });

    }, function () {
        locals.access = Object.assign({
            larcId: locals.larc.id,
            name: locals.larc.username,
        }, locals.scheme && {
            schemeId: locals.scheme.id,
            dialPrefix: locals.scheme.dialPrefix,
        });
        if (locals.larc.nosio > 0) // disabled
            locals.accessJwt = undefined;
        else if (locals.larc.nosio === 0) // enabled
            locals.accessJwt = mesh.accessJwt(locals.access);
        else if (locals.scheme) // auto:associated
            locals.accessJwt = mesh.accessJwt(locals.access);
        else // auto:unassociated
            locals.accessJwt = undefined;

        locals.config && console.log('config:', JSON.stringify(locals.config));
        res.json(locals.json = {
            accessJwt: locals.accessJwt,
            arcStall: (locals.scheme || {}).arcStall, // prevent arc-failure retry cycling
            authority: main.cache.tls.cert, // used by larcs to verify user-credential cookies
            cert: locals.cert || undefined,
            chain: locals.chain || undefined,
            config: locals.config || undefined, // optional assembled config fragments to master only
            fqdn: locals.fqdn, // for TLS certificate creation
            lastCdrMs: locals.lastCdrMs, // enables incremental CDR upload
            live: Boolean((locals.scheme || {}).live), // activates correct lostnode email-address
            mainurl: main.identity, // hostname : port
            moshHost: os.hostname(), // ensure packet relay via this host
            moshPort: locals.moshPort || null, // optional nexus liason port
            periodS: locals.moshPort ? 600 : 3600,
            privkey: locals.privkey || undefined,
            secret: (locals.scheme || {}).secret,
            upgrade: locals.upgrade, // [none, offer, schedule] - git-pull suggestion
        });

    });
});
