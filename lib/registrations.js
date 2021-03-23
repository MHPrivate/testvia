var chain = require('scope-chain');
var debug = require('debug')('registrations');
var esl = require('./esl');
var main = require.main.exports;
var mysql = require('./mysql');

module.exports = Object.assign(exports, {
    ready: ready,
});

esl.on('esl::ready', ready) && esl.authed && ready(undefined); // explicit call if already emitted
function ready() {
    debug('esl::ready', arguments.length ? 'fixup' : 'event');
    chain(function cleanup(err) {
        err && console.log('registrations: fail:', err);

    }, function () {
        esl.showX('registrations', this);

    }, function (parsed, json) {
        debug.enabled && debug('custom: harvest', JSON.stringify(parsed.rows));
        parsed && process.emit('sipRegister', parsed, 'harvest'); // { row_count, rows }
        this();

    });
}

esl.on('esl::event::CUSTOM::*', custom);
function custom(evt, hdrs, body) {
    custom.debug || (custom.debug = debug.extend('custom'));
    custom.reAOR || (custom.reAOR = /((?:[\w\-.!%*_+`'~]+)(?:\s+[\w\-.!%*_+`'~]+)*|"[^"\\]*(?:\\.[^"\\]*)*")?\s*\<\s*([^>]*)\s*\>/);
    custom.reTSP || (custom.reTSP = /transport=(\w+)/i);
    if (!evt)
        return;
    esl.parseEvt.call(this, evt);
    custom.debug(evt.when, evt.event, evt.subclass, evt);

    var locals = {};
    switch (evt.subclass) {
        case 'sofia::unregister':
            break; // don't record unregisters as they may overwrite registers against another server
        case 'sofia::register':
            locals.aor = (evt.headers.contact || '').match(custom.reAOR);
            locals.tsp = locals.aor && (locals.aor[2].match(custom.reTSP) || [])[1];
            locals.row = Object.assign(Object.create(evt), {
                expires: +evt.headers['Event-Date-Timestamp'] / 1000000 + +evt.headers.expires,
                hostname: evt.headers['FreeSWITCH-Hostname'],
                network_ip: evt.headers['network-ip'],
                network_port: evt.headers['network-port'],
                network_proto: locals.tsp ? locals.tsp.toLowerCase() : 'udp',
                profile: evt.headers['profile-name'],
                reg_user: evt.headers['sip_auth_username'],
                realm: evt.headers['sip_auth_realm'],
                token: evt.headers['call-id'],
                url: locals.aor && locals.aor[2],
                //metadata:
            });
            debug.enabled && debug('custom: track', JSON.stringify([locals.row]));
            process.emit('sipRegister', { row_count: 1, rows: [locals.row] }, 'track'); // in line with parsed from 'show registrations as json'
            break;
    }
}

process.on('sipRegister', function onSipRegister(parsed, hint) { // { row_count, rows:[{reg_user,realm,token,url,expires,network_ip,network_port,network_proto,hostname,?metadata}] }
    var locals = { rows: parsed.rows.slice() };
    chain(function cleanup(err) {
        err && console.log('onSipRegister:', err);

    }, function loop() {
        if (!(locals.row = locals.rows.shift()))
            return this();

        this.index || (this.index = hint || '???');
        var json = JSON.stringify(locals.row);
        chain(this, function () {
            mysql('update sipUsers set value=? where user=? and name="registration"', [json, locals.row.reg_user], this);

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol,changedRows}
            if (status.affectedRows)
                return loop.call(this.this);

            mysql(mysql.mksql('sipUsers', {
                name: 'registration',
                scope: 'user',
                type: 'json',
                user: locals.row.reg_user,
                value: json,
            }), this);

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol,changedRows}
            loop.call(this.this);

        });
    });
});
