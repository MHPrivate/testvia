#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('apns');
var fork = require('child_process').fork;
var main = require.main.exports;
var mysql = require('./mysql');

// apns-sub.js is run non-strict at the apn module depends on node-forge that fails under strict usage
process.running.then(function apns() {
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
        mysql('select * from apnsApps where aptUuid in (' + mysql.qmks(data.devices) + ')', data.devices, this);

    }, function (apps, meta) {
        if (!apps.length)
            return done(null, 0);
        this.tokenApps = {}, this.rigDevices = [[], []];
        apps.forEach(function (app, idx, arr) {
            this.tokenApps[app.token] = app;
            this.rigDevices[app.sandbox ? 1 : 0].push(app.token);
        }, this);
        this.notify = {
            rigDevices: this.rigDevices,
            note: {
                //expiry: // no (from php example)
                badge: 0, // yes (from php example)
                sound: 'default', // yes (from php example)
                alert: 'incoming call', // yes (from php example)
                contentAvailable: true, // yes (from php example)
                //priority: // no (from php example)
                payload: { // no (from php example)
                    voipNotify: {
                        //callerId: '401990500',
                        //hasVideo: true,
                        utcMs: Date.now(),
                    },
                },
            },
        };
        debug('pknotify: sending', this.notify);
        exports.sub.once('message', this.noerror).send(this.notify);

    }, function (message, handle) { // { [sent], failed:[{device,status,response:{reason}] }
        debug('pknotify: result', message);
        this.message = message;
        if (!message.failed.length) // no failures - so nothing to delete
            return this();
        var deleteIds = message.failed.reduce(function (wksp, fail, idx, arr) {
            if (fail.response.reason === 'BadDeviceToken')
                wksp.push(this[fail.device].id);
            return wksp;
        }.bind(this.tokenApps), []);
        deleteIds.length ? mysql('delete from apnsApps where id in (' + mysql.qmks(deleteIds) +  ')', deleteIds, this) : this();

    }, function (status) {
        debug('pknotify: deletes', status);
        var delayMs = main.secrets.apns.delayMs || 2000;
        this(null, this.message.sent.length ? delayMs : 0); // valid recipients - so return a delayMs

    });
}
