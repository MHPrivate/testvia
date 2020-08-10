#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('harvest');
var diff = require('deep-object-diff').diff;
var mysql = require('./mysql');

module.exports = Object.assign(exports, {
    locals: undefined,
    pending: new Set,
    recurse: recurse,
    timeout: undefined,
    waitMs: 30000,
});

function once(fn /*, ... */) { // optional extra args can be used to report additional calls
    fn = Array.from(arguments); // transform into a single element array
    return function once() {
        return !fn.length ? undefined : fn.shift().apply(this, arguments);
    }
}

process.on('harvest', exports); // queue one or more sio(s) for HQ config harvesting
function exports(/* sio, ... */) { // {locals:{authority,certificate,ip,ipv6,ipv4,fqdn,master,access:{larcId,name,?schemeId,?dialPrefix,iat,exp},statement:{gitdate,?master,?disconnectReason}}}
    var locals = { busy: arguments.length && exports.pending.size, sqls: [] }; // no-args means ignore _busy_ (from nextTick below)
    Array.from(arguments).forEach(function (sio, idx, arr) {
        if (!sio || sio.locals.master === false || !sio.locals.access.schemeId) // ignore if specifically not-master
            return;
        debug('harvest:', sio.locals.access.dialPrefix);
        sio.locals.harvest = new Date;
        exports.pending.add(sio);
    });
    debug('pending:', exports.pending.size);

    if (locals.busy || !exports.pending.size) // already busy OR nothing pending
        return exports.locals;

    exports.timeout = exports.timeout && clearTimeout(exports.timeout); // reset any outstanding delay-timeout as we're spawning a new harvest
    exports.locals = locals;
    exports.pending.forEach(function (sio, key, set) {
        if (!sio.connected)
            return set.delete(sio);
        if (locals.harvest < sio.locals.harvest)
            return;
        locals.harvest = sio.locals.harvest;
        locals.sio = sio;
    });
    if (exports.waitMs && (locals.delayMs = exports.waitMs + +locals.harvest - Date.now()) > 0) {
        debug('delayMs:', locals.delayMs);
        return (exports.timeout = setTimeout(exports, locals.delayMs)) && exports.locals; // set a delay-timeout
    }

    locals.sio && chain(function cleanup(err) {
        err && console.log('harvest:', locals.sio && locals.sio.locals.access.dialPrefix, err);
        exports.pending.delete(locals.sio);
        process.nextTick(exports);

    }, function () {
        this.index = locals.sio.locals.access.dialPrefix;
        locals.schemeId = locals.sio.locals.access.schemeId;
        locals.sio.emit('config2', (this.timeout = setTimeout(once(this), 5000))._onTimeout); // set a 5s recovery-timeout for the response

    }, function (latest) {
        if (!latest)
            return this('timeout');
        this.timeout = clearTimeout(this.timeout); // reset the 5s recovery-timeout on the'config2' response
        locals.latest = latest;
        mysql('select * from config where schemeId=? and nameSlashed="/scheme"', [locals.schemeId], this);

    }, function (configs, meta) {
        locals.configs = configs;
        locals.delta = diff(JSON.parse((configs[0] || { valueString: '{}' }).valueString), locals.latest);
        locals.actions = recurse.call({}, '/scheme', locals.delta);
        var values;
        for (var name in locals.actions) {
            values = [
                typeof locals.actions[name] === 'boolean' ? locals.actions[name] : null,
                typeof locals.actions[name] === 'number' ? locals.actions[name] : null,
                typeof locals.actions[name] === 'string' ? locals.actions[name] : null,
            ];
            if (locals.actions[name] === undefined)
                locals.sqls.push(mysql.format('delete from config where schemeId=? and (nameSlashed=? or nameSlashed like ?)', [locals.schemeId, name, name + '.%']));
            else
                locals.sqls.push(mysql.mksql('config', {
                    nameSlashed: name,
                    schemeId: locals.schemeId,
                    valueBoolean: values[0],
                    valueNumber: values[1],
                    valueString: values[2],
                    visibilityScheme: 1,
                }) + mysql.format(' on duplicate key update valueBoolean=?,valueNumber=?,valueString=?', values));
        }

        var sql = mysql.mksql('config', {
            nameSlashed: '/scheme',
            schemeId: locals.schemeId,
            valueBoolean: null, // reset out-of-date indicator
            valueString: JSON.stringify(locals.latest),
            visibilityScheme: true,
        }, locals.configs[0]);
        sql && locals.sqls.push(sql);
        this(null, locals.sqls.slice());

    }, function loop(sqls) {
        if (!sqls.length)
            return this();

        chain(this, function () {
            var sql = sqls.shift();
            mysql(sql, sql.length < (exports.tooLong || 1024), this.noerror); // prevent tracing overly long sql

        }, function (err, status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
            if (!err)
                null;
            else if (err.code !== 'ER_LOCK_DEADLOCK')
                throw err;
            else
                console.log('ER_LOCK_DEADLOCK:', sqls.unshift(err.sql) && err.sql);
            loop.call(this.this, sqls);

        });

    });
    return exports.locals;

}

function recurse(prefix, obj) {
    if (this === exports)
        return recurse.call({}, prefix, obj);
    for (var key in obj)
        if (typeof obj[key] === 'object')
            recurse.call(this, prefix + '.' + key, obj[key]);
        else
            this[prefix + '.' + key] = obj[key];
    return this;
}
