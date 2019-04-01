#! /usr/bin/env node-strict
require('./running'); // generates _process_ 'running' & 'terminate' events
var debug = require('debug')('mysql');
var extend = require('node.extend');
var main = require.main.exports;
var mysql = require('mysql');
var setTimeout = global.setTimeout;

// err
//    Error {
//        Error: ER_NO_DEFAULT_FOR_FIELD: Field 'json' doesn 't have a default value
//            at Query.Sequence._packetToError(/opt/appello - via / node_modules / mysql / lib / protocol / sequences / Sequence.js:47:14)
//            at ... etc
//        code: 'ER_NO_DEFAULT_FOR_FIELD',
//        errno: 1364,
//        sqlMessage: 'Field \'json\' doesn\'t have a default value',
//        sqlState: 'HY000',
//        index: 0,
//        sql: 'insert into schemeCdrs () values ()'
//    }

// update-status
//    OkPacket {
//        fieldCount: 0,
//        affectedRows: 1,
//        insertId: 0,
//        serverStatus: 2,
//        warningCount: 0,
//        message: '(Rows matched: 1  Changed: 0  Warnings: 0',
//        protocol41: true,
//        changedRows: 0
//    }

module.exports = extend(exports, {
    Raw: Raw,
    db: null,
    format: mysql.format,
    hide: hide,
    mksql: mksql,
    pending: 0, // count of outstanding queries
    uptime: 0, // uptime of last query (not affected by clock adjustments)
});

process.once('running', function () {
    if (main.secrets.mysql.ssl.ca.join)
        main.secrets.mysql.ssl.ca = main.secrets.mysql.ssl.ca.join('\n');
    exports.db = mysql.createPool(main.secrets.mysql);
    process.emit('mysql'); // announce database ready
    process.once('terminate', function _mysql() {
        var delay = 1 + exports.uptime - process.uptime(); // seconds to delay
        delay > 0 && debug('terminate: delay', delay);
        setTimeout(function _mysqlTimeout() {
            var delay = 1 + exports.uptime - process.uptime(); // seconds to delay
            if (!exports.pending && delay < 0)
                return exports.db.end();
            delay < 0 && (delay = 1);
            debug('terminate: delay', delay);
            setTimeout(_mysqlTimeout, delay * 1000);
        }, delay > 0 && delay * 1000);
    });
});

// from - /usr/include/mysql/mysql_com.h
// MYSQL_TYPE_DECIMAL 0             NOT_NULL_FLAG 1
// MYSQL_TYPE_TINY 1                PRI_KEY_FLAG 2
// MYSQL_TYPE_SHORT 2               UNIQUE_KEY_FLAG 4
// MYSQL_TYPE_LONG 3                MULTIPLE_KEY_FLAG 8
// MYSQL_TYPE_FLOAT 4               BLOB_FLAG 16
// MYSQL_TYPE_DOUBLE 5              UNSIGNED_FLAG 32
// MYSQL_TYPE_NULL 6                ZEROFILL_FLAG 64
// MYSQL_TYPE_TIMESTAMP 7           BINARY_FLAG	128
// MYSQL_TYPE_LONGLONG 8
// MYSQL_TYPE_INT24 9
// MYSQL_TYPE_DATE 10
// MYSQL_TYPE_TIME 11
// MYSQL_TYPE_DATETIME 12
// MYSQL_TYPE_YEAR 13
// MYSQL_TYPE_NEWDATE 14
// MYSQL_TYPE_VARCHAR 15
// MYSQL_TYPE_BIT 16
// MYSQL_TYPE_NEWDECIMAL 246
// MYSQL_TYPE_ENUM 247
// MYSQL_TYPE_SET 248
// MYSQL_TYPE_TINY_BLOB 249
// MYSQL_TYPE_MEDIUM_BLOB 250
// MYSQL_TYPE_LONG_BLOB 251
// MYSQL_TYPE_BLOB 252
// MYSQL_TYPE_VAR_STRING 253
// MYSQL_TYPE_STRING 254
// MYSQL_TYPE_GEOMETRY 255


function exports(query, params, trace, cb) {
    if (['boolean', 'function'].indexOf(typeof (params)) != -1) { // missing params
        cb = trace;
        trace = params;
        params = undefined;
    }
    if (['function'].indexOf(typeof (trace)) != -1) { // missing trace
        cb = trace;
        trace = true;
    }
    cb = cb || Function.prototype;
    if (!query)
        return cb && cb(null, null);
    if (Array.isArray(params))
        query = mysql.format(query, params);
    if (trace)
        debug(cb.index, query);
    ++exports.pending;
    return exports.db.query(query, function (err) {
        --exports.pending;
        exports.uptime = process.uptime();
        cb.apply(this, arguments);
    });
}

function Raw(s) {
    if (!(this instanceof Raw))
        return new Raw(s);
    this.s = s;
}

mksql.debug = debug.extend('mksql');
function mksql(table, update, data, key) {
    key = key || 'id';
    if (!data && update[key])
        (data = {})[key] = update[key];
    if (data) { // update
        var sql = '', val = [], json;
        Object.keys(update).sort().forEach(function (key, i, a) {
            if (update[key] instanceof Raw) {
                mksql.debug('raw ' + key);
                sql += key + '=' + update[key].s + ',';
            } else if (update[key] instanceof Date) {
                mksql.debug('date ' + key);
                sql += key + '=?,';
                val.push(data[key] = update[key]);
            } else if (update[key] instanceof Buffer) {
                mksql.debug('buffer ' + key);
                sql += key + '=?,';
                val.push(data[key] = update[key]);
            } else if (update[key] !== null && typeof (update[key]) == 'object') {
                mksql.debug('object ' + key);
                if ((json = JSON.stringify(update[key])) !== data[key]) {
                    sql += key + '=?,';
                    val.push(data[key] = json);
                }
            } else if (key in data && update[key] == data[key]) {
                mksql.debug('unchanged ' + key);
            } else if (update[key] !== undefined) {
                mksql.debug('simple: ' + key + ' ' + typeof (update[key]));
                sql += key + '=?,';
                val.push(data[key] = update[key]);
            }
        })
        if (sql) {
            val.push(data[key]);
            sql = 'update ' + table + ' set ' + sql.slice(0, -1) + ' where ' + key + '=?';
            mksql.debug(sql, val);
            return mysql.format(sql, val);
        }
    } else { // insert
        var sql = '', plh = '', val = [];
        Object.keys(update).sort().forEach(function (key, i, a) {
            if (update[key] instanceof Raw) {
                mksql.debug('raw ' + key);
                sql += key + '=' + update[key].s;
                plh += update[key] + ',';
            } else if (update[key] instanceof Date) {
                mksql.debug('date ' + key);
                sql += key + ',';
                plh += '?,';
                val.push(update[key]);
            } else if (update[key] instanceof Buffer) {
                mksql.debug('buffer ' + key);
                sql += key + ',';
                plh += '?,';
                val.push(update[key]);
            } else if (update[key] !== null && typeof (update[key]) == 'object') {
                mksql.debug('object ' + key);
                sql += key + ',';
                plh += '?,';
                val.push(JSON.stringify(update[key]));
            } else if (update[key] !== undefined) {
                mksql.debug('simple: ' + key + ' ' + typeof (update[key]));
                sql += key + ',';
                plh += '?,';
                val.push(update[key]);
            }
        });
        if (sql && plh)
            sql = 'insert into ' + table + ' (' + sql.slice(0, -1) + ') values (' + plh.slice(0, -1) + ')';
            mksql.debug(sql, val);
            return mysql.format(sql, val);
    }
}

function hide(field) {
    if (field.flags & 128) switch (field.type) { // BINARY
        case 249: // TINY_BLOB
        case 250: // MEDIUM_BLOB
        case 251: // LONG_BLOB
        case 252: // BLOB
            return true;
    }
}
