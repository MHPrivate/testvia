#! /usr/bin/env node-strict
var basic = require('basic-auth');
var chain = require('scope-chain');
var express = require('express');
var main = require.main.exports;
var mysql = require('../../lib/mysql');
var peers = require('../../lib/mesh/peers');

module.exports = exports = express.Router();

exports.post('/', function (req, res, next) { // POST /v1/mosh {moshPort, moshSecret}
    // expects: Authorization: Basic base64(HEX16:HEX32)
    //  name(HEX16) taken from /proc/cpuinfo:Serial - RaspberryPi-serialNo
    //  pass(HEX32) taken from /sys/block/mmcblk0/device/cid  - SDcard-cid
    //console.log('mosh:', req.body.moshPort, 'secret', req.body.moshSecret);
    var locals = req.locals;
    locals.credentials = basic(req);

    //console.log('larc:', locals.credentials.name, JSON.stringify(req.body));
    next.index = req.index;
    chain(next, function () {
        mysql('select * from larcs where username=? and password=?', [locals.credentials.name, locals.credentials.pass], this);

    }, function (larcs, meta) { // prepare the database row
        if (!larcs.length)
            return this('route');
        main.emit('mosh', req.body.moshPort, req.body.moshSecret);
        peers.emit('mosh', { port: req.body.moshPort, secret: req.body.moshSecret });
        res.json({});

    });
});
