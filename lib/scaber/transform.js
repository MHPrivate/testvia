#! /usr/bin/env node-strict
var chain = require('scope-chain');
var debug = require('debug')('transform');
var mysql = require('../mysql');
var nowip = require('../nowip');
var worker = require('./worker');

Object.assign(module.exports, {
    atm: atm, // attempt transform to ATM
    mrq2atm: mrq2atm, // attempt transform of mrq to ATM
    tt2atm: tt2atm, // attempt transform of tt to ATM
});

function atm(payload, cb) { // _this_ is the session
    if (payload.ATM) // already have ATM
        cb(null, payload);
    else if (payload.mrq)
        mrq2atm.call(this, payload, cb);
    else if (payload.tt)
        tt2atm.call(this, payload, cb);
    else
        cb();
}

function mrq2atm(payload, cb) { // _this_ is the session
    var session = this;
    chain(cb, function () {
        var mrq = payload.mrq, wheres = this.wheres = [];
        this.dty = ('0000' + +mrq.dty[0]).slice(-4);
        this.stc = ('0000' + +mrq.stc[0]).slice(-4);
        this.lco = ('000' + +mrq.lco[0]).slice(-3);
        this.did = (mrq.did[0].match(/^\s*(.*)\s*$/) || [])[1] || '';
        wheres.push(
            '/scaip/cid/' + payload.originUser + '/nowip',
            '/scaip/dty/' + this.dty + '/nowip',
            '/scaip/lco/' + this.lco + '/nowip',
            '/scaip/stc/' + this.stc + '/nowip',
            '/scaip/dty/' + this.dty + '/lco/' + this.lco + '/nowip',
            '/scaip/dty/' + this.dty + '/lco/' + this.lco + '/did/' + this.did + '/nowip',
            '/scaip/dty/' + this.dty + '/stc/' + this.stc + '/nowip',
            '/scaip/dty/' + this.dty + '/stc/' + this.stc + '/did/' + this.did + '/nowip',
        );
        worker.configJson(wheres.filter(Boolean), {}, this);

    }, function (atm) {
        var unknowns = ['event', 'location'].filter(function (attr, idx, arr) { return attr in this === false }, atm);
        unknowns.length && console.log('mrq2atm unknown', JSON.stringify({ UNKNOWNS: unknowns, dty: this.dty, lco: this.lco }));
        var lhdigits = session.context.lhdigits || '', controllerunit = lhdigits + ('000000000000' + payload.originUser).slice(-12).slice(lhdigits.length);
        payload.ATM = {
            data: [nowip.stringify(atm = Object.assign({
                    controllerunit: controllerunit,
                }, atm))],
        };
        payload.mrq.geo && (payload.ATM.wgs = [payload.mrq.geo]);    // non-standard NOWIP item
        this(null, payload);

    });
}

function tt2atm(payload, cb) {
    var session = this;
    chain(cb, function () {
        var tt = payload.tt, wheres = this.wheres = [];
        wheres.push(
            '/tunstall/did/' + payload.originUser + '/nowip',
            '/tunstall/gentyp/' + tt.generic + tt.type + '/nowip',
            '/tunstall/callcode/' + tt.callcode + '/nowip',
        );
        worker.configJson(wheres, {}, this);

    }, function (atm) {
        Object.assign(atm, atm[atm._isg ? '_grp' : '_dis']);
        var unknowns = ['event', 'location'].filter(function (attr, idx, arr) { return attr in this === false }, atm);
        unknowns.length && console.log('mrq2atm unknown', JSON.stringify({ UNKNOWNS: unknowns, dty: this.dty, lco: this.lco }));
        var lhdigits = session.context.lhdigits || '', controllerunit = lhdigits + ('000000000000' + payload.originUser).slice(-12).slice(lhdigits.length);
        payload.ATM = {
            data: [nowip.stringify(atm = Object.assign({
                    speech: payload.tt.hvs ? 1 : 2,
                    controllerunit: controllerunit,
                }, atm))],
        };
        this(null, payload);

    });
}