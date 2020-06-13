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
});

process.on('harvest', exports);
function exports(/* sio, ... */) { // {locals:{authority,certificate,ip,ipv6,ipv4,fqdn,master,access:{larcId,name,?schemeId,?dialPrefix,iat,exp},statement:{gitdate,?master,?disconnectReason}}}
    var locals = { busy: arguments.length && exports.pending.size, sqls: [] }; // no-args means ignore _busy_ (from nextTick below)
    for (var n in arguments) {
        arguments[n] && arguments[n].locals.access.schemeId && exports.pending.add(arguments[n]);
        arguments[n].locals.harvest = new Date;
        debug('harvest:', arguments[n].locals.access.dialPrefix);
    }
    debug('pending:', exports.pending.size);

    if (locals.busy || !exports.pending.size) // already busy OR nothing pending
        return exports.locals;

    exports.timeout = exports.timeout && clearTimeout(exports.timeout);
    exports.locals = locals;
    exports.pending.forEach(function (sio, key, set) {
        if (!sio.connected)
            return set.delete(sio);
        if (locals.harvest < sio.locals.harvest)
            return;
        locals.harvest = sio.locals.harvest;
        locals.sio = sio;
    });
    if ((locals.delayMs = 10000 + +locals.harvest - Date.now()) > 0) {
        debug('delayMs:', locals.delayMs);
        return (exports.timeout = setTimeout(exports, locals.delayMs)) && exports.locals;
    }

    locals.sio && chain(function cleanup(err) {
        err && console.log('harvest:', err);
        exports.pending.delete(locals.sio);
        process.nextTick(exports);

    }, function () {
        this.index = locals.sio.locals.access.dialPrefix;
        locals.schemeId = locals.sio.locals.access.schemeId;
        locals.sio.emit('config2', this);

    }, function (latest) {
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
                locals.sqls.push(mysql.format('delete from configs where schemeId=? and nameSlashed=?', [locals.schemeId, name]));
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
            mysql(sqls.shift(), this.noerror);

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
