#! /usr/bin/env node-strict
module.exports = exports;

function exports(req, res) {
    res.writeHead(404, { 'Content-Length': 0 });
    res.end();
}
