#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('firebase');
var main = require.main.exports;
var mysql = require('./mysql');
var request = require('request');

module.exports = Object.assign(exports, {
    iokNotify: iokNotify,
    voipNotify: voipNotify,
});

function iokNotify(hqData, cb) { // {endUtc, devices:{<uuid>:bool, ...}}, cb(err)
    if (!Object.keys(hqData.devices).length)
        return cb(null, 0);
    var body = { // this is cloned for each request
        //to: 'token'
        //registration_ids: ['token', ...]
        collapse_key: 'iokNotify', // only deliver latest to targets
        data: {
            iokNotify: {
                endUtc: hqData.endUtc, // maybe undefined and therefore absent
                //iok: <boolean>,
            },
        },
        time_to_live: 3600 * 12, // discard undelivered after 12hrs
        //notification: {
        //    endUtc: hqData.endUtc, // maybe undefined and therefore absent
        //    //iok: <boolean>,
        //},
        priority: 'high', // normal|high
        content_available: true,
    };
    var locals = { channels: main.secrets.firebases || [], uuids: Object.keys(hqData.devices), chanStates: [], tokenIds: {} };
    chain(cb, function () {
        mysql('select * from firebaseApps where aptUuid in (' + mysql.qmks(locals.uuids) + ')', locals.uuids, this);

    }, function (apps, meta) {
        var chanState;
        for (var n in apps) {
            locals.tokenIds[apps[n].token] = apps[n].id;
            chanState = (apps[n].userAgent || '').includes('appelloltd') << 1 | hqData.devices[apps[n].aptUuid]; // chan:bool << 1 | state:bool
            locals.chanStates[chanState] || (locals.chanStates[chanState] = []);
            locals.chanStates[chanState].push(apps[n].token);
        }
        this(null, 0);

    }, function loop(chanState) {
        while (chanState < locals.chanStates.length && !locals.chanStates[chanState])
            chanState++;
        var chan = chanState >> 1, tokens = locals.chanStates[chanState];
        if (chan >= locals.channels.length) // non-Channel
            return this();
        if (!tokens)
            return loop.call(this, chanState + 1); // skip on if no tokens to notify

        body.data.iokNotify.iok = Boolean(chanState & 1);
        //body.notification.iok = body.data.iokNotify.iok;
        var json = Object.assign({}, body);
        (tokens.length > 1) ? (json.registration_ids = tokens) : (json.to = tokens[0]);

        chain(this, function () {
            debug.enabled && debug('iokNotify: request', JSON.stringify(json));
            request({
                method: 'POST',
                url: locals.channels[chan].url,
                headers: {
                    authorization: 'key=' + (locals.channels[chan].serverKey || locals.channels[chan].legacy),
                },
                json: json,
            }, this.noerror);

        }, function (err, rsp, body) {
            rsp && rsp.statusCode !== 200 && console.log('iokNotify: response', JSON.stringify(rsp));
            debug.enabled && debug('iokNotify: response', JSON.stringify(body));
            var results = rsp && rsp.body && rsp.body.results, deleteIds = [];
            for (var n in results) {
                switch (results[n].error) {
                    case undefined:
                        continue;
                    case 'NotRegistered':
                        deleteIds.push(locals.tokenIds[tokens[n]]);
                }
                console.log('iokNotify: fail', results[n], locals.tokenIds[tokens[n]], tokens[n]);
            }
            deleteIds.length ? mysql('delete from firebaseApps where id in (' + mysql.qmks(deleteIds) + ')', deleteIds, this) : this();

        }, function (status) {
            loop.call(this.this, chanState + 1);

        });

    });
}

function voipNotify(hqData, cb) { // {devices:[<duid>, ...],?callerId,?hasVideo}, cb(err, delayMs)
    if (!hqData.devices.length)
        return cb(null, 0);
    var body = { // this is cloned for each request
        //to: 'token'
        //registration_ids: ['token', ...]
        collapse_key: 'voipNotify', // only deliver latest to targets
        data: {
            voipNotify: {
                callerId: hqData.callerId,
                hasVideo: hqData.hasVideo,
                utcMs: Date.now(),
            }
        },
        time_to_live: 30, // discard undelivered after 30sec
        priority: 'high', // normal|high
    };
    var locals = {
        channels: main.secrets.firebases || [],
        chans: [],
        delayMs: 0,
        sent: 0,
        tokenIds: {},
    };
    chain(cb, function () {
        mysql('select * from firebaseApps where aptUuid in (' + mysql.qmks(hqData.devices) + ') and userAgent not like "%iOS%"', hqData.devices, this);

    }, function (apps, meta) {
        for (var n in apps) {
            locals.tokenIds[apps[n].token] = apps[n].id;
            var chan = +(apps[n].userAgent || '').includes('appelloltd'); // chan:bool
            locals.chans[chan] || (locals.chans[chan] = []);
            locals.chans[chan].push(apps[n].token);
        }
        this(null, 0);

    }, function loop(chan) {
        while (chan < locals.chans.length && !locals.chans[chan])
            chan++;
        var tokens = locals.chans[chan];
        var delayMs = main.secrets.apns.delayMs || 2000;
        if (chan >= locals.channels.length) // non-Channel
            return this(null, locals.delayMs);
        if (!tokens)
            return loop.call(this, chan + 1); // skip on if no tokens to notify

        var json = Object.assign({}, body);
        (tokens.length > 1) ? (json.registration_ids = tokens) : (json.to = tokens[0]);

        chain(this, function () {
            debug.enabled && debug('voipNotify: request', JSON.stringify(json));
            request({
                method: 'POST',
                url: locals.channels[chan].url,
                headers: {
                    authorization: 'key=' + (locals.channels[chan].serverKey || locals.channels[chan].legacy),
                },
                json: json,
            }, this.noerror);

        }, function (err, rsp, body) {
            rsp && rsp.statusCode !== 200 && console.log('voipNotify: response', JSON.stringify(rsp));
            debug.enabled && debug('voipNotify: response', JSON.stringify(body));
            var results = rsp && rsp.body && rsp.body.results, deleteIds = [];
            for (var n in results) {
                switch (results[n].error) {
                    case undefined:
                        locals.delayMs = Math.max(locals.delayMs, locals.channels[chan].delayMs || 2000);
                        continue;
                    case 'NotRegistered':
                        deleteIds.push(locals.tokenIds[tokens[n]]);
                }
                console.log('voipNotify: fail', results[n], locals.tokenIds[tokens[n]], tokens[n]);
            }
            if (!deleteIds.length)
                return this();
            mysql('delete from firebaseApps where id in (' + mysql.qmks(deleteIds) + ')', deleteIds, this);

        }, function (status) {
            loop.call(this.this, chan + 1);

        });

    });
}
