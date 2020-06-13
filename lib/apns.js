#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('apns');
var fork = require('child_process').fork;
var main = require.main.exports;
var mysql = require('./mysql');

// apns-sub.js is run non-strict at the apn module depends on node-forge that fails under strict usage
process.running.then(function apns() {
    debug('forking apns-sub');
    // need to 'ignore' stdio to obscure excessive diagnostics from @parse/node-apn
    var stdio = ['ignore', debug.enabled ? 'inherit' : 'ignore', 'inherit', 'ipc']; // at launch - not dynamic
    exports.sub = fork(require.resolve('./apns-sub.js'), { execArgv: [], stdio: stdio });
});
process.once('terminate', function _apns() {
    debug('closing apns-sub');
    exports.sub && exports.sub.disconnect();
});

exports.pknotify = pknotify;
function pknotify(hqData, done) { // {devices:[<duid>, ...],?callerId,?hasVideo}, done(err, message, handle)
    if (!hqData.devices || !hqData.devices.length)
        return done(null, 0);
    if (!exports.sub.connected)
        return done(new Error('apns-sub.js has failed'));
    chain(done, function () {
        mysql('select * from apnsApps where aptUuid in (' + mysql.qmks(hqData.devices) + ')', hqData.devices, this);

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
                //badge: 0, // yes (from php example) - kees requested removal
                //sound: 'default', // yes (from php example) - kees requested removal
                //alert: 'incoming call', // yes (from php example) - kees requested removal
                //contentAvailable: true, // yes (from php example) - kees requested removal
                //priority: // no (from php example)
                payload: { // no (from php example)
                    voipNotify: {
                        callerId: hqData.callerId,
                        hasVideo: hqData.hasVideo,
                        utcMs: Date.now(),
                    },
                },
            },
        };
        debug.enabled && debug('pknotify: send', JSON.stringify(this.notify));
        exports.sub.once('message', this.noerror).send(this.notify);

    }, function (message, handle) { // { [sent], failed:[{device,status,response:{reason}] }
        debug.enabled && debug('pknotify: recv', JSON.stringify(message));
        this.message = message;
        if (!message.failed.length) // no failures - so nothing to delete
            return this();
        var deleteIds = message.failed.reduce(function (wksp, fail, idx, arr) {
            if (fail.response.reason === 'BadDeviceToken')
                wksp.push(this[fail.device].id);
            return wksp;
        }.bind(this.tokenApps), []);
        deleteIds.length ? mysql('delete from apnsApps where id in (' + mysql.qmks(deleteIds) +  ')', deleteIds, this) : this();

    }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol41,changedRows}
        status && debug('pknotify: deletes', status);
        var delayMs = main.secrets.apns.delayMs || 2000;
        this(null, this.message.sent.length ? delayMs : 0); // valid recipients - so return a delayMs

    });
}
