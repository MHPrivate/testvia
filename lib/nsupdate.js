#!/usr/bin/env node-strict
var chain = require('scope-chain');
var main = require.main.exports;
var mysql = require('./mysql');
var path = require('path');
var spawn = require('child_process').spawn;

module.exports = Object.assign(exports, {
    active: false,
    chains: [],
    chainMs: 20000,
    flush: flush,
    fqdnCheck: fqdnCheck,
});

function flush(done) {
    if (exports.active)
        return done();
    exports.active = true;
    var locals = {};
    chain(function cleanup(err) {
        exports.active = false;
        done.apply(this, arguments);

    }, function () {
        this.index = done.index;
        mysql('select * from fqdns where applied is null order by fqdn', this);

    }, function (fqdns, meta) {
        locals.fqdns = fqdns;
        if (!fqdns.length) // no pending cache fqdns to publish
            return this();

        fqdns.forEach(function (fqdn, idx, arr) {
            this.push(['del', fqdn.fqdn + '.', fqdn.type].join(' '));
            fqdn.value && this.push(['add', fqdn.fqdn + '.', 300, 'in', fqdn.type, fqdn.value].join(' '));
        }, locals.cmds = []);

        var cmd = spawn(path.resolve(__dirname, '..', 'bash', 'nsupdate.sh'), { stdio: ['pipe', process.stdout, process.stderr] });
        cmd.on('error', this); // delivers: (err)
        cmd.on('close', this.bind(null, null)); // delivers: (null, code, signal)
        cmd.stdin.end(locals.cmds.concat(['show', 'send', '']).join('\n'));

    }, function (code, signal) {
        if (!locals.fqdns.length) // nothing published
            return this();
        if (code > 0) // publish failed in some way
            return this();

        // mark the published fqdns as published
        locals.ids = locals.fqdns.map(function (fqdn, idx, arr) {
            return fqdn.id;
        });
        mysql('update fqdns set applied=? where id in (?)', [new Date, locals.ids], this);

    }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
        if (!locals.fqdns.length) // nothing published
            return this();

        locals.status = status;
        this();

    });
}

function fqdnCheck(fqdn, type, value, done) { // done(err, cert, privkey, chain, noChange)
    if (!fqdn)
        return done();
    var locals = {};
    chain(done, function () {
        mysql('select * from fqdns where fqdn=? and type=?', [fqdn, type], this);

    }, function (fqdns, meta) {
        locals.fqdn = fqdns[0] || {};
        if (locals.fqdn.value === value)
            return this();

        mysql(mysql.mksql('fqdns', {
            fqdn: fqdn,
            type: type,
            value: value,
            applied: null,
        }, fqdns[0]), this);

    }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
        locals.status = status;
        if (!locals.fqdn.chainId) // no chain to fetch
            return this();
        if (locals.chain = exports.chains[locals.fqdn.chainId]) // look for cached chain
            return this();
        mysql('select * from leChains where id=?', [locals.fqdn.chainId], this);

    }, function (chains, meta) {
        if (chains && chains.length) {
            exports.chains[chains[0].id] = locals.chain = chains[0];
            setTimeout(function nsupdate(id) { exports.chains[id] = null }, exports.chainMs || 20000, chains[0].id).unref();
        }
        this(null, locals.fqdn.cert, locals.fqdn.privkey, (locals.chain || {}).chain, !(locals.status || {}).affectedRows);

    });
}
