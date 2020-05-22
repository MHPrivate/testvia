#! /usr/bin/env node-strict
var main = require.main.exports;

module.exports = Object.assign(exports, {
    '192-168-': 'c',
    '172-16-': 'ba',
    '172-17-': 'bb',
    '172-18-': 'bc',
    '172-19-': 'bd',
    '172-20-': 'be',
    '172-21-': 'bf',
    '172-22-': 'bg',
    '172-23-': 'bh',
    '172-24-': 'bi',
    '172-25-': 'bj',
    '172-26-': 'bk',
    '172-27-': 'bl',
    '172-28-': 'bm',
    '172-29-': 'bn',
    '172-30-': 'bo',
    '172-31-': 'bp',
    '10-': 'a',
});

function exports(ipv4) {
    ipv4 = ipv4.replace(/\./g, '-') + '.' + main.secrets.fqdn;
    for (var prefix in exports)
        if (ipv4.startsWith(prefix)) {
            ipv4 = exports[prefix] + ipv4.slice(prefix.length);
            break;
        }
    return ipv4;
}
