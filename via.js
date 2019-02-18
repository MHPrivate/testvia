#! /usr/bin/env node-strict
require('./lib/running').running = undefined; // causes main.running set _true_ once running AND _false_ while terminating

require('./lib/replify')(!process.stdin.isTTY); // starts either a console:repl OR a daemon:replify (/run/<main>.sock)
