#!/usr/bin/env node-strict
var debug = require('debug')('minut');
var chain = require('scope-chain');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mysql = require('./mysql');
var request = require('request');

module.exports = Object.assign(exports, {
    pirProbe: pirProbe,
    refresh: refresh,
});

refresh.debug = debug.extend('refresh');
function refresh(owners, next) { //- refresh OAuth refresh/access tokens
    var self = this, owner = owners.shift();
    if (!owner)
        return next();

    var locals = {};
    owners.locals ? owners.locals.push(locals) : (owners.locals = [locals]);
    chain(next, function () {
        request(locals.oauth = {
            method: 'POST',
            uri: main.secrets.minut.tokenUri,
            headers: {
                'cache-control': 'no-cache',
            },
            json: true,
            body: {
                client_id: owner.clientId,
                client_secret: main.secrets.minut[owner.clientId].clientSecret,
                refresh_token: owner.refreshToken,
                grant_type: 'refresh_token',
            },
        }, this);

    }, function (resp, body) {
        locals.oauth.resp = resp; // body===resp.body
        refresh.debug.enabled && refresh.debug('request:', JSON.stringify(locals.oauth));
        if (resp.statusCode < 200 || resp.statusCode >= 300)
            return next(new Error(['failed to refresh Minut access_token:', resp.statusCode, resp.statusMessage].join(' ')));

        locals.access = jwt.decode(body.access_token);
        this.owner = {
            accessExpires: new Date(locals.access ? locals.access.exp * 1000 : body.expires_in * 1000 + Date.now()),
            accessToken: resp.body.access_token,
            refreshToken: resp.body.refresh_token,
        };
        refresh.debug.enabled && refresh.debug('before:', JSON.stringify(owner), JSON.stringify(this.owner));
        mysql(mysql.mksql('minutOwners', this.owner, owner), this);

    }, function (status) {
        refresh.debug.enabled && refresh.debug('after:', JSON.stringify(owner));
        refresh.call(self, owners, next);

    });
}

process.on('pirProbe', pirProbe);
pirProbe.debug = debug.extend('pirProbe');
function pirProbe(schemeId, schemeUnit, windowSecs, done) { // done(err, utc)
    var locals = pirProbe.locals = { now: new Date, reqs: [], utc: 0 };
    chain(done, function () { // fetch all minutDevices for schemeUnit
        mysql('select * from minutDevices where schemeId=? and schemeUnit=?', [schemeId, schemeUnit], this);

    }, function (devices, meta) {
        (locals.devices = devices).forEach(function (device, idx, arr) { // build a Set of ownerIds
            this.add(device.ownerId);
        }, locals.ownerIds = new Set);
        if (!locals.ownerIds.size) // no owners
            return done();

        // fetch all minutOwners for minutDevices
        mysql('select * from minutOwners where ownerId in (' + mysql.qmks(locals.ownerIds) + ')', Array.from(locals.ownerIds), this);

    }, function (owners, meta) { // renew any refreshTokens expired or nearing expiry
        locals.refresh = (locals.owners = owners).filter(function (owner, idx, arr) { // build a Map of ownerIds=>owners
            this.set(owner.ownerId, owner);
            var renew = locals.now - owner.accessExpires > 60000;
            pirProbe.debug('renew:', owner.ownerId, locals.now, '-', owner.accessExpires, '> 60000', renew);
            return renew;
        }, locals.ownerIds = new Map); // create a list of owners required a new access_token
        refresh(locals.refresh, this);

    }, function () {
        pirProbe.debug.enabled && pirProbe.debug('ownerIds:', JSON.stringify(Array.from(locals.ownerIds.values())))
        this(null, locals.devices.slice()); // call the next function with a copy of the devices list

    }, function loop(devices) { // foreach device
        var device = devices.shift(), timeResolution = windowSecs < 300 ? windowSecs : 300, req;
        while (device && !locals.ownerIds.has(device.ownerId)) // where we have a useable owner
            device = devices.shift();
        if (!device) // no more devices - report motion at end indication time window by adding timeResolution to utc
            return !locals.utc ? this() : this(null, locals.utc + timeResolution);

        locals.reqs.push(req = {});
        chain(this, function () { // fetch pir_history
            request(req.devices = {
                method: 'GET',
                uri: main.secrets.minut.devicesUri + '/' + device.deviceId + '/motion_events',
                headers: {
                    'authorization': 'Bearer ' + locals.ownerIds.get(device.ownerId).accessToken,
                    'cache-control': 'no-cache',
                },
                qs: {
                    start_at: new Date(Date.now() - windowSecs * 1000),
                    time_resolution: timeResolution,
                },
                json: true,
            }, this);

        }, function (resp, body) { // body={unit,time_resolution,values:[[sec,count],...]}
            req.devices.resp = resp; // resp.body = body
            pirProbe.debug.enabled && pirProbe.debug('request:', JSON.stringify(req.devices));
            if (resp.statusCode < 200 || resp.statusCode >= 300) { // fetch failed
                console.log('pirProbe: failed to get Minut motion_events:', device.deviceId, resp.statusCode, resp.statusMessage);
                return loop.call(this.this, devices);
            }
            for (var i = body.values.length - 1; body.values[i] && !body.values[i][1]; --i); // find the latest motion
            if (i < 0) // not found any motion
                return loop.call(this.this, devices);

            if (locals.utc < body.values[i][0]) // find the most recent across all devices
                locals.utc = body.values[i][0];
            loop.call(this.this, devices);

        });

    });
}
