#! /usr/bin/env node-strict
var main = require('./lib/running');

require('./lib/replify')(!process.stdin.isTTY);
