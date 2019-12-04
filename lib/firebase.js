#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('firebase');
var extend = require('node.extend');
var main = require.main.exports;
var mysql = require('./mysql');
var request = require('request');

exports.iokNotify = iokNotify;
function iokNotify(hqData, cb) { // hqData{devices:{<uuid>:<state>}, endUtc} cb(err)
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
        //notification: {
        //    title: 'Nexus',
        //    body: 'iokNotify',
        //},
        time_to_live: 3600 * 12, // discard undelivered after 12hrs
        notification: {
            endUtc: hqData.endUtc, // maybe undefined and therefore absent
            //iok: <boolean>,
        },
        priority: 'high',
        content_available: true,
    };
    var locals = { channels: main.secrets.firebases || [], uuids: Object.keys(hqData.devices), chanStates: [], tokenIds: {} };
    chain(cb, function () {
        var qmks = locals.uuids.map(function (uuid, idx, arr) { return '?' }).join();
        mysql('select * from firebaseApps where aptUuid in (' + qmks + ')', locals.uuids, this);

    }, function (apps, meta) {
        var chanState;
        for (var n in apps) {
            locals.tokenIds[apps[n].token] = apps[n].id;
            chanState = apps[n].userAgent.includes('appelloltd') << 1 | hqData.devices[apps[n].aptUuid]; // chan:bool << 1 | state:bool
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
        body.notification.iok = body.data.iokNotify.iok;
        var json = Object.assign({}, body);
        (tokens.length > 1) ? (json.registration_ids = tokens) : (json.to = tokens[0]);

        chain(this, function () {
            request({
                method: 'POST',
                url: locals.channels[chan].url,
                headers: {
                    authorization: 'key=' + locals.channels[chan].legacy,
                },
                json: json,
            }, this.noerror);

        }, function (err, rsp) {
            rsp && rsp.statusCode !== 200 && console.log('iokNotify: response', JSON.stringify(rsp));
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
            if (!deleteIds.length)
                return this();
            mysql('delete from firebaseApps where id in (' + deleteIds.join() + ')', this);

        }, function (status) {
            loop.call(this.this, chanState + 1);

        });

    });
}
