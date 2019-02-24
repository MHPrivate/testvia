#! /usr/bin/env node-strict
//var apns = require('../apns');
var chain = require('scope-chain');
var debug = require('debug')('mesh:larcs');
var events = require('events');
var extend = require('node.extend');
//var firebase = require('../firebase');
//var mosh = require('../mosh');
var mysql = require('../mysql');
//var nsupdate = require('../nsupdate');

module.exports = extend(exports, {
    handlers: {
        established: function onEstablished() { // faked by exports() - update nexus:larcs to record connect
            debug('onEstablished:', this.locals.access.dialPrefix, this.locals.access.name);
            this.locals.larcId && chain(null, function () {
                this.index = this.locals.access.name; // so mysql calls can log the originator
                mysql(mysql.mksql('larcs', { linkTic: new Date, linkUrl: this.mesh.url }, { id: this.locals.access.larcId }), this);
            });
        },
        disconnect: function onDisconnect(reason) { // update nexus:larcs to record disconnect
            debug.enabled && debug.apply(null, ['onDisconnect:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)));
            this.locals.larcId && chain(null, function () {
                this.index = this.locals.access.name; // so mysql calls can log the originator
                mysql(mysql.mksql('larcs', { linkTic: new Date, linkUrl: null }, { id: this.locals.access.larcId }), this);
            });
        },
        heartbeat: function onHeartbeat() { // conditionally share our updated authority SSL certificate
            debug.enabled && debug('onHeartbeat:', this.locals.access.dialPrefix, this.locals.access.name);
            if (!this.locals.authority)
                return;
            this.locals.authority = this.emit('authority', main.cache.tls.cert) && false;
        },
        log: function onLog(data) {
            debug.enabled
                ? debug.apply(null, ['onLog:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log.apply(console, ['mesh:larcs:log:', this.locals.dialPrefix, this.locals.name].concat(Array.from(arguments)));
        },
        mosh: function onMosh(data) { // LARCs upto '2018-06-26T18:00:04Z' inclusive
            debug.enabled && debug.apply(null, ['onMosh:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)));
            process.emit('mosh', data.port, data.secret, data.host);
        },
        probe: function onProbe(probe) { // LARCs upto '2018-06-26T18:00:04Z' inclusive
            debug.enabled
                ? debug.apply(null, ['onProbe:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log('mesh:larcs:probe:', this.locals.dialPrefix, this.locals.name, JSON.stringify(probe));
        },
        master: function onMaster(master) {
            debug.enabled
                ? debug.apply(null, ['onMaster:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log('mesh:larcs:master:', this.locals.dialPrefix, this.locals.name, master);
        },
        offsite: function onOffsite(offsite) {
            debug.enabled
                ? debug.apply(null, ['onOffsite:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log('mesh:larcs:offsite:', this.locals.dialPrefix, this.locals.name, offsite);
        },
        config: function onConfig(config) {
            debug.enabled
                ? debug.apply(null, ['onConfig:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log('mesh:larcs:config:', this.locals.dialPrefix, this.locals.name, JSON.stringify(config));
        },
        configItems: function onConfigItems(items) { // {dialPrefix,ipv4,ipv6,mac,mailto,vipv4}
            debug.enabled
                ? debug.apply(null, ['onConfigItems:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log('onConfigItems:', this.locals.access.dialPrefix, this.locals.access.name, JSON.stringify(items));
            var soc = this;
            chain(null, function () {
                this.index = soc.locals.access.name; // so mysql calls can log the originator
                mysql('select * from larcs where id=?', [soc.locals.access.larcId], this);

            }, function (larcs, meta) {
                larcs.length && mysql(mysql.mksql('larcs', {
                    ipv4i: items.ipv4 && ipaddr.IPv4.parse(items.ipv4).toString(),
                    ipv6: items.ipv6 && ipaddr.IPv6.parse(items.ipv6).toString(),
                }, larcs[0]), this); // update only

            });
        },
        appWakeup: onAppWakeup, // required for LARCs after '2018-08-15T13:25:59Z'
        pushTokens: onPushTokens, // required for LARCs after '2018-08-15T13:25:59Z'
        iok: function onIok(data, cb) {
            debug.enabled
                ? debug.apply(null, ['onIok:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)))
                : console.log('mesh:larcs:iok:', this.locals.dialPrefix, this.locals.name, JSON.stringify(data));
            var soc = this;
            chain(cb, function () {
                this.index = soc.locals.access.name; // so mysql calls can log the originator
                firebase.iokNotify(data, this);

            }, function (err, status) {
                err ? this(err.message) : this(null, status);

            });
        },
        cdr: function onCdr(cdr, cb) {
            debug.enabled && debug.apply(null, ['onCdr:', this.locals.access.dialPrefix, this.locals.access.name].concat(Array.from(arguments)));
            var soc = this;
            chain(cb, function () {
                this.index = soc.locals.access.name; // so mysql calls can log the originator
                mysql('insert into schemeCdrs (`from`,`json`,`schemeId`,`started`,`uuid`) values (?,?,?,?,?)', [cdr.from, JSON.stringify(cdr), soc.locals.access.schemeId, new Date(cdr.startUtcms), cdr.uuid], this.noerror);

            }, function (err, status) {
                err ? this(err.sqlMessage || err.message) : this(null, status);

            });
        },
        deviceEvent: onDeviceEvent,
    },
});

function exports(gitdate, done) { // _this_ is the ioSocket
    this.locals.gitdate = gitdate;
    if (this.locals.access.dialPrefix)
        this.locals.fqdn = this.locals.access.dialPrefix + '.hq.' + main.secrets.fqdn;
    debug('larc:', this.locals.access.name, this.locals.access.dialPrefix);

    var soc = this;
    Object.keys(exports.handlers).forEach(function (handler, idx, arr) {
        soc.on(handler, this[handler]);
    }, exports.handlers);
    events.prototype.emit.call(soc, 'established'); // signal as established (ioServer)

    chain(done, function () {
        this.index = soc.locals.access.name; // so mysql calls can log the originator
        mysql(mysql.mksql('larcs', { ipv4x: soc.locals.ipv4, seen: new Date}, { id: soc.locals.access.larcId }), this);

    }, function (status) {
        if (!soc.locals.fqdn)
            return this();
        nsupdate.fqdnCheck(soc.locals.fqdn, 'a', soc.locals.ipv4, this);

    }, function (cert, privkey, chain, noChange) {
        if (!arguements.length || noChange)
            return this();
        nsupdate(this);

    });
}

function onAppWakeup(data, cb) {
    debug.enabled
        ? debug.apply(null, ['onAppWakeup:'].concat(Array.from(arguments).map(function (arg, idx, arr) {
            return typeof arg === 'function' ? 'function' : arg;
        })))
        : console.log('mesh:appWakeup:', this.locals.access.dialPrefix, this.locals.access.name, JSON.stringify(data));
    var soc = this;
    chain(cb || null, function () {
        this.index = soc.locals.access.name; // so mysql calls can log the originator
        apns.pknotify(data, this.noerror);

    }, function (err) {
        err ? this(err.message) : this();

    });
}

function onPushTokens(data, cb) { // {uuid,oat,firebase,apns,sandbox}
    debug.enabled
        ? debug.apply(null, ['onPushTokens:'].concat(Array.from(arguments).map(function (arg, idx, arr) {
            return typeof arg === 'function' ? 'function' : arg;
        })))
        : console.log('mesh:pushTokens:', this.locals.access.dialPrefix, this.locals.access.name, JSON.stringify(data));
    return cb && cb();

    var soc = this, affectedRows = 0;
    chain(function cleanup(err) {
        err && console.log('pushTokens:', err);
        cb && cb(err ? err.sqlMessage || err.message : null, Boolean(affectedRows));

    }, function () {
        this.index = soc.locals.access.name;
        var wheres = [], values = [];
        isNaN(+data.oat) || (data.oat = data.oat.toString());
        if (data.uuid && data.oat)
            wheres.push('(aptUuid=? and appOat=?)') && values.push(data.uuid, data.oat);
        if (data.firebase)
            wheres.push('(crc32=? and token=?)') && values.push(crc32(data.firebase), data.firebase);
        if (!wheres.length) // no search criteria
            return cb(null, false);
        if ('firebase' in data === false) // skip firebase
            return this();
        mysql('select * from firebaseApps where ' + wheres.join(' or '), values, this);

    }, function (apps, meta) {
        if (!apps || !apps.length) // no matching rows
            return this();
        if (data.firebase) for (var i = apps.length - 1; i >= 0; --i) // find a possible row to update
            if (apps[i].aptUuid === data.uuid && apps[i].appOat === data.oat)
                this.firebase = apps.splice(i, 1).shift();
        if (!apps.length || 'firebase' in data === false) // no rows for deletion
            return this();
        mysql('delete from firebaseApps where id in (' + [apps.map(function (app, idx, arr) { return app.id })].join() + ')', this);

    }, function (status) {
        status && (affectedRows += status.affectedRows);
        if (!data.uuid || !data.oat || !data.firebase) // nothing to insert/update
            return this();
        var app = {
            appOat: data.oat.toString(),
            aptUuid: data.uuid,
            crc32: crc32(data.firebase),
            schemeId: soc.locals.access.schemeId,
            token: data.firebase,
        };
        mysql(mysql.mksql('firebaseApps', app, this.firebase), this); // insert/update

    }, function (status) {
        status && (affectedRows += status.affectedRows);
        var wheres = [], values = [];
        isNaN(+data.oat) || (data.oat = data.oat.toString());
        if (data.uuid && data.oat)
            wheres.push('(aptUuid=? and appOat=?)') && values.push(data.uuid, data.oat);
        if (data.apns)
            wheres.push('(crc32=? and token=?)') && values.push(crc32(data.apns), data.apns);
        if (!wheres.length) // no search criteria
            return cb(null, false);
        if ('apns' in data === false) // skip apns
            return this();
        mysql('select * from apnsApps where ' + wheres.join(' or '), values, this);

    }, function (apps, meta) {
        if (!apps || !apps.length) // no matching rows
            return this();
        if (data.apns) for (var i = apps.length - 1; i >= 0; --i) // find a possible row to update
            if (apps[i].aptUuid === data.uuid && apps[i].appOat === data.oat)
                this.apns = apps.splice(i, 1).shift();
        if (!apps.length || 'apns' in data === false) // no rows for deletion
            return this();
        mysql('delete from apnsApps where id in (' + [apps.map(function (app, idx, arr) { return app.id })].join() + ')', this);

    }, function (status) {
        status && (affectedRows += status.affectedRows);
        if (!data.uuid || !data.oat || !data.apns)
            return this();
        var app = {
            appOat: data.oat.toString(),
            aptUuid: data.uuid,
            crc32: crc32(data.apns),
            sandbox: data.sandbox ? 1 : 0,
            schemeId: soc.locals.access.schemeId,
            token: data.apns,
        };
        mysql(mysql.mksql('apnsApps', app, this.apns), this); // insert/update

    }, function (status) {
        status && (affectedRows += status.affectedRows);
        this();

    });
}

function onDeviceEvent(data, cb) { // {uuid,oat,firebase,apns,sandbox}
    debug.enabled
        ? debug.apply(null, ['onDeviceEvent:'].concat(Array.from(arguments).map(function (arg, idx, arr) {
            return typeof arg === 'function' ? 'function' : arg;
        })))
        : console.log('mesh:deviceEvent:', this.locals.access.dialPrefix, this.locals.access.name, JSON.stringify(data));
    var soc = this;
    chain(cb || null, function () {
        this.index = soc.locals.access.name; // so mysql calls can log the originator
        this.event = {
            failed: new Date,
            inactive: data.inactive,
            json: JSON.stringify(data),
            mac: data.mac,
            model: data.model,
            node: data.note,
            schemeId: soc.locals.access.schemeId,
            user: data.user,
            uuid: data.uuid,
        };
        if (data.lost) // this is a loss event
            return this();
        mysql('select id from deviceEvents where schemeId=? and uuid=? and okayed is null', [soc.locals.access.schemeId, data.uuid], this);

    }, function (deviceEvents, meta) {
        if (!deviceEvents) // this is a loss event
            return mysql(mysql.mksql('deviceEvents', this.event), this); // insert the new loss event
        this.event.okayed = this.event.failed;
        var ids = deviceEvents.map(function (deviceEvent, idx, arr) { return deviceEvent.id });
        if (!ids.length) // this is a lost/recover event
            return mysql(mysql.mksql('deviceEvents', this.event), this);
        mysql('update deviceEvents set okayed=? where id in (?)', [this.event.okayed, ids], this.noerror);

    }, function (err, status) {
        err ? this(err.sqlMessage || err.message) : this(null, status);

    }, function (status) {
        this(null, false); // hardcode prevent HQ from skipping other methods of alerting (email)

    });
}

