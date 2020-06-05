var chain = require('scope-chain');
var debug = require('debug')('minutz');
var express = require('express');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var minut = require('../lib/minut');
var mysql = require('../lib/mysql');
var os = require('os');
var request = require('request');

module.exports = exports = express.Router();

process.running.then(function () {
    exports.clientId = Object.keys(main.secrets.minut).filter(function (key, idx, arr) {
        return this[key].clientSecret;
    }, main.secrets.minut)[0];
});

exports.get('/callback', function (req, res, next) { // GET /minutz/callback?code=...
    if (!exports.clientId || !req.user || !req.query.code)
        return res.redirect('https://appello.care/minut/linkage');
    next.index = req.index;
    var locals = req.locals;
    chain(next, function () {
        request(locals.oauth = { //- transform OAuth code into refresh/access tokens
            method: 'POST',
            uri: main.secrets.minut.tokenUri,
            headers: {
                'cache-control': 'no-cache',
            },
            json: true,
            body: {
                client_id: exports.clientId,
                client_secret: main.secrets.minut[exports.clientId].clientSecret,
                code: req.query.code,
                grant_type: 'authorization_code',
                redirect_uri: main.secrets.minut[exports.clientId].redirectUri,
            },
        }, this);

    }, function (resp, body) { // body={access_token,expires_in,refresh_token,type_type,user_id}
        locals.oauth.resp = resp; // body===resp.body
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            console.log('minutz:callback token', resp.statusCode, resp.statusMessage);
            return res.redirect('https://appello.care/minut/linkage');
        }
        locals.access = jwt.decode(body.access_token);
        locals.expires = new Date(locals.access ? locals.access.exp * 1000 : body.expires_in * 1000 + Date.now());

        request(locals.webhooks = { //- harvest any existing webhooks
            method: 'GET',
            uri: 'https://api.minut.com/v1/webhooks',
            headers: {
                authorization: 'Bearer ' + locals.oauth.resp.body.access_token,
                'cache-control': 'no-cache',
            },
            json: true,
        }, this);

    }, function (resp, body) { // body={access_token,expires_in,refresh_token,type_type,user_id}
        locals.webhooks.resp = resp; // body===resp.body
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            console.log('minutz:callback webhooks', resp.statusCode, resp.statusMessage);
            return res.redirect('https://appello.care/minut/linkage');
        }

        var webhooks = locals.webhooks.resp.body.hooks.map(function (hook, idx, arr) {
            return hook.hook_id;
        });
        this(null, webhooks);

    }, function loop(webhooks) {
        var webhook = webhooks.shift();
        if (!webhook)
            return this();
        chain(this, function () {
            console.log('minutz:callback webunhook', webhook);
            request({
                method: 'DELETE',
                uri: 'https://api.minut.com/v1/webhooks/' + webhook,
                headers: {
                    authorization: 'Bearer ' + locals.oauth.resp.body.access_token,
                    'cache-control': 'no-cache',
                },
                json: true,
            }, this);

        }, function (resp, body) {
            if (resp.statusCode < 200 || resp.statusCode >= 300) {
                console.log('minutz:callback webunhook', resp.statusCode, resp.statusMessage);
                return res.redirect('https://appello.care/minut/linkage');
            }

            loop.call(this.this, webhooks);

        });

    }, function () {
        request(locals.webhook = { //- create required webhooks
            method: 'POST',
            uri: 'https://api.minut.com/v1/webhooks',
            headers: {
                authorization: 'Bearer ' + locals.oauth.resp.body.access_token,
                'cache-control': 'no-cache',
            },
            json: true,
            body: {
                //hook_secret: '???',
                url: 'https://minut.appello.care/minutz/webhook/all',
                token: exports.clientId,
                events: [
                    //'alarm_heard',                        // user+admin
                    //'glassbreak',                         // user+admin
                    //'short_button_press',                 // user+admin
                    //'temperature_high',                   // user
                    //'temperature_low',                    // user
                    //'temperature_dropped_normal',         // user
                    //'temperature_risen_normal',           // user
                    //'humidity_high',                      // user
                    //'humidity_lo',                        // user
                    //'humidity_dropped_normal',            // user
                    //'humidity_risen_normal',              // user
                    //'avg_sound_high',                     // user
                    //'sound_level_high_despite_warning',   // user
                    //'sound_level_dropped_normal',         // user
                    'device_offline',                       // user+admin
                    'device_online',                        // user+admin
                    'tamper',                               // user+admin
                    //'battery_low',                        // user+admin
                    //'battery_empty',                      // user+admin

                    //'smoke_detected',                     // admin
                    'pir_motion',                           // user+admin
                    //'battery_charging_complete',          // admin
                ],
            },
        }, this);

    }, function (resp, body) { // body={hook_id,hook_secret,url,token,events}
        locals.webhook.resp = resp; // body===resp.body
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            console.log('minutz:callback webhook', resp.statusCode, resp.statusMessage);
            return res.redirect('https://appello.care/minut/linkage');
        }

        request(locals.devices = { //- harvest any existing devices
            method: 'GET',
            uri: 'https://api.minut.com/v1/devices',
            headers: {
                authorization: 'Bearer ' + locals.oauth.resp.body.access_token,
                'cache-control': 'no-cache',
            },
            json: true,
        }, this);

    }, function (resp, body) { // body={devices:[ see: https://api.minut.com/v1/docs/#tag/Devices/paths/~1devices/get ]}
        locals.devices.resp = resp; // body===resp.body
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            console.log('minutz:callback devices', resp.statusCode, resp.statusMessage);
            return res.redirect('https://appello.care/minut/linkage');
        }

        body.devices.forEach(function (dev, idx, arr) { //- fetch any known devices from the database
            this.push(dev.device_mac);
        }, locals.macs = []);
        mysql('select * from minutDevices where deviceMac in (' + mysql.qmks(locals.macs) + ')', locals.macs, this);

    }, function (devices, meta) { // {id,deviceId,deviceMac,installerId,ownerId,schemeId,schemeUnit}
        devices.forEach(function (device, idx, arr) { // transform array of existing devices into dictionary keyed on deviceMac
            this[device.deviceMac] = device;
        }, locals.knownDevices = {});

        this(null, locals.devices.resp.body.devices.slice());

    }, function loop(devices) { //- ensure each existing device is in the database
        var dev = devices.shift();
        //{
        //    device_id, device_mac, device_bluetooth_address, owner, home, active, offline, first_seen_at, last_heard_from_at, last_heartbeat_at, firmware
        //    hardware_version, description, timezone, configuration, ongoing_events, battery, location, listening_mode, homekit_enabled, insights,
        //    mould_risk_level, muted_until, hap_paired, hap_mfi_provisioned, hap_setup_payload, charge_status
        //}
        if (!dev)
            return this();
        chain(this, function () { //- insert OR update minutDevice record
            var device = { deviceId: dev.device_id, ownerId: dev.owner };
            if (!locals.knownDevices[dev.device_mac])
                Object.assign(device, { deviceMac: dev.device_mac, installerId: req.user.id });
            mysql(mysql.mksql('minutDevices', device, locals.knownDevices[dev.device_mac]), this);

        }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol,changedRows}
            loop.call(this.this, devices);

        });

    }, function () {
        request(locals.user = { // fetch owner record
            method: 'GET',
            uri: 'https://api.minut.com/v1/users/' + locals.oauth.resp.body.user_id,
            headers: {
                authorization: 'Bearer ' + locals.oauth.resp.body.access_token,
                'cache-control': 'no-cache',
            },
            json: true
        }, this);

    }, function (resp, body) { // body={user_id,fullname,nick,email,subscribe_newsletter,creatred_at,updated_at,roles,share_location,locale}
        locals.user.resp = resp; // body===resp.body
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
            console.log('minutz:callback user', resp.statusCode, resp.statusMessage);
            return res.redirect('https://appello.care/minut/linkage');
        }

        //- fetch any known owner record from the database
        mysql('select * from minutOwners where ownerId=?', [locals.oauth.resp.body.user_id], this);

    }, function (owners, meta) {
        var owner = locals.owner = owners.shift();
        mysql(mysql.mksql('minutOwners', { //- insert OR update minutOwner record
            accessExpires: locals.expires,
            accessToken: locals.oauth.resp.body.access_token,
            clientId: exports.clientId,
            linkerId: req.user.id,
            ownerEmail: locals.user.resp.body.email,
            ownerId: locals.oauth.resp.body.user_id,
            refreshToken: locals.oauth.resp.body.refresh_token,
        }, owner), this);

    }, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol,changedRows} - report outcome
        locals.status = status;
        if (status && !status.affectedRows) {
            console.log('minutz:callback db', status.message);
            return res.redirect('https://appello.care/minut/linkage');
        }

        return res.redirect('https://appello.care/minut/linkage?ownerId=' + locals.oauth.resp.body.user_id);

    });
});

exports.all('/webhook/:type', function (req, res, next) { // GET /minutz/webhook/:type
    var locals = req.locals;
    next.index = req.index;
    chain(next, function () {
        mysql('select d.* from minutOwners o join minutDevices d on o.ownerId=d.ownerId where o.clientId=? and d.deviceId=?', [req.headers.authorization, req.body.event.device_id], this);

    }, function (devices, meta) {
        var device = (locals.devices = devices)[0];
        if (!device || req.body.event.type !== 'pir_motion')
            return res.sendStatus(200);

        debug.enabled && debug('minutz-webhook:', JSON.stringify({ type: req.params.type, query: req.query, headers: req.headers, body: req.body }));
        if (req.body.event.type !== 'pir_motion')
            return res.sendStatus(200);

        req.headers.authorization = Buffer.from(req.body.event.device_id + ':').toString('base64');
        process.emit('rpscb', 'scheme:' + device.schemeId, 'pirMotion', { unit: device.schemeUnit, origin: 'minut' });
        res.end();

    });
});

exports.all('/subscription/:type', function (req, res, next) { // GET /minutz/subscription/:type
    var locals = req.locals;
    next.index = req.index;
    chain(next, function () {
        mysql('select * from minutOwners where clientId=?', [req.headers.authorization], this);

    }, function (owners, meta) {
        if (!owners.length)
            return this();
        locals.owner = owners.shift();
    //    mysql(mysql.mksql('minutOwners', { callbackHost: os.hostname() }, locals.owner), this);
    //
    //}, function (status) { // {fieldCount,affectedRows,insertId,serverStatus,warningCount,message,protocol,changedRows}
    //    if (!status.affectedRows)
    //        return this();
        console.log('minutz-subscription:', JSON.stringify({ type: req.params.type, query: req.query, headers: req.headers, body: req.body }));
        res.end();

    });
});

/// utility functions
//function minutRefresh(locals, next) { //- refresh OAuth refresh/access tokens
//    chain(next, function () {
//        request(locals.oauth = {
//            method: 'POST',
//            uri: main.secrets.minut.tokenUri,
//            headers: {
//                'cache-control': 'no-cache',
//            },
//            json: true,
//            body: {
//                client_id: exports.clientId,
//                client_secret: main.secrets.minut[exports.clientId].clientSecret,
//                refresh_token: locals.owners[0].refreshToken,
//                grant_type: 'refresh_token',
//            },
//        }, this);
//
//    }, function (resp, body) {
//        locals.oauth.resp = resp; // body===resp.body
//        if (resp.statusCode < 200 || resp.statusCode >= 300)
//            return next(new Error(['failed to refresh Minut access_token:', resp.statusCode, resp.statusMessage].join(' ')));
//
//        locals.access = jwt.decode(body.access_token);
//        locals.expires = new Date(locals.access ? locals.access.exp * 1000 : body.expires_in * 1000 + Date.now());
//        this();
//
//    });
//}
