#! /usr/bin/env node-strict

module.exports = exports = require('../rpscb');

process.on('rpscb', exports.publish.bind(exports));

process.running.then(function () {
    require('./certificate');   // process.emit('rpscb', 'certificate', fqdn, cert, chain, key)
    //require('./davAuth');       // process.emit('rpscb', 'davAuth', uuid, jwts) // stash only
    require('./drop2');         // process.emit('rpscb', 'drop2', larcId, cb) // cb(err, ourUrl)
    require('./find2');         // process.emit('rpscb', 'find2', larcId, cb) // cb(err, ourUrl)
    require('./larc2');         // process.emit('rpscb', 'larc2', larcId, event, ... cb) // cb(err, ourUrl)
    require('./mosh');          // process.emit('rpscb', 'mosh', port, secret, host)
    require('./mosh2');         // process.emit('rpscb', 'mosh2', larcId, cb) // cb(err, host, port, secret)
    require('./proxy2');        // process.emit('rpscb', 'proxy2', larcId, [data, [force,]] cb) // { appUrl, sipUrl, secret }, force, cb(err, ourUrl)
    require('./server2');       // process.emit('rpscb', 'server2', cb) // cb(err, ourUrl)
});
