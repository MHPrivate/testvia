#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('firebase');
var extend = require('node.extend');
var main = require.main.exports;
var mysql = require('./mysql');
var request = require('request');

exports.iokNotify = iokNotify;
function iokNotify(hqData, cb) { // hqData{devices:{<uuid>:<state>}, endUtc} cb(err)
    var stateUuids = Object.keys(hqData.devices).reduce(function (wksp, uuid, idx, arr) {
        this[uuid] in wksp || (wksp[this[uuid]] = []);
        wksp[this[uuid]].push(uuid);
        return wksp
    }.bind(hqData.devices), {});

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
    chain(cb, function () {
        this(null, Object.keys(stateUuids));

    }, function loop(states) {
        if (!states.length)
            return this();
        body.data.iokNotify.iok = (states.shift() === 'true');
        body.notification.iok = body.data.iokNotify.iok;
        var json = extend({}, body), uuids = stateUuids[body.data.iokNotify.iok];
        chain(this, function () {
            var qmks = uuids.map(function (uuid, idx, arr) { return '?' }).join(',');
            mysql('select * from firebaseApps where aptUuid in (' + qmks + ')', uuids, this);

        }, function (apps, meta) {
            if (!apps.length)
                return this();
            this.apps = apps;
            var tokens = apps.map(function (app, idx, arr) { return app.token });
            (tokens.length > 1) ? (json.registration_ids = tokens) : (json.to = tokens[0]);
            console.log('iokNotify:', JSON.stringify(json));
            request({
                method: 'POST',
                url: main.secrets.firebase.url,
                headers: {
                    authorization: 'key=' + main.secrets.firebase.legacy,
                },
                json: json,
            }, this.noerror);

        }, function (err, rsp) {
            rsp && rsp.statusCode !== 200 && console.log('iokNotify: response', JSON.stringify(rsp));
            var results = rsp && rsp.body && rsp.body.results;
            var apps = results && this.apps.filter(function (app, idx, arr) { // develop a list of apps to delete based on results
                this[idx].error && console.log('iokNotify:', this[idx], app.id, app.token);
                return this[idx].error === 'NotRegistered';
            }, results);
            if (!apps || !apps.length) // nothing to delete
                return this();
            mysql('delete from firebaseApps where id in (?)', [apps.map(function (app, idx, arr) { return app.id })], this);

        }, function (status) {
            loop.call(this.this, states);

        });
    });
}
