#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('apns');
var fork = require('child_process').fork;
var mysql = require('./mysql');

// apns-sub.js is run non-strict at the apn module depends on node-forge that fails under strict usage
process.once('running', function apns() {
    debug('forking apns-sub');
    exports.sub = fork(require.resolve('./apns-sub.js'), { execArgv: [] });
});
process.once('terminate', function _apns() {
    debug('closing apns-sub');
    exports.sub && exports.sub.disconnect();
});

exports.pknotify = pknotify;
function pknotify(data, done) { // [uuids], done(err, message, handle)
    if (!data.devices || !data.devices.length)
        return done(null, 0);
    if (!exports.sub.connected)
        return done(new Error('apns-sub.js has failed'));
    chain(done, function () {
        var qmks = data.devices.map(function (uuid, idx, arr) { return '?' });
        mysql('select * from apnsApps where aptUuid in (' + qmks + ')', data.devices, this);

    }, function (apps, meta) {
        if (!apps.length)
            return done(null, 0);
        this.tokenApps = {}, this.rigDevices = [[], []];
        apps.forEach(function (app, idx, arr) {
            this.tokenApps[app.token] = app;
            this.rigDevices[app.sandbox ? 1 : 0].push(app.token);
        }, this);
        debug('pknotify: sending to', this.rigDevices);
        exports.sub.once('message', this.noerror).send({
            rigDevices: this.rigDevices,
            note: {
                //expiry: // no (from php example)
                badge: 0, // yes (from php example)
                sound: 'default', // yes (from php example)
                alert: 'incoming call', // yes (from php example)
                contentAvailable: true, // yes (from php example)
                //priority: // no (from php example)
                //payload: // no (from php example)
            },
        });

    }, function (message, handle) { // { [sent], failed:[{device,status,response:{reason}] }
        debug('pknotify: result', message);
        this.message = message;
        if (!message.failed.length) // no failures - so nothing to delete
            return this();
        var deletes = message.failed.reduce(function (wksp, fail, idx, arr) {
            if (fail.response.reason === 'BadDeviceToken')
                wksp.push(this[fail.device].id);
            return wksp;
        }.bind(this.tokenApps), []);
        mysql('delete from apnsApps where id in (?)', [deletes.join()], this);

    }, function (status) {
        debug('pknotify: deletes', status);
        this(null, this.message.sent.length ? 5000 : 0); // valid recipients - so return a delayMs

    });
}
