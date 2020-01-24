var chain = require('scope-chain');
var express = require('express');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mysql = require('../lib/mysql');
var request = require('request');

module.exports = exports = express.Router();

process.once('running', function () {
    exports.clientId = Object.keys(main.secrets.minut).filter(function (key, idx, arr) {
        return this[key].clientSecret;
    }, main.secrets.minut)[1];
});

exports.get('/callback', function (req, res, next) { // GET /minuty/callback?code=...
    if (!(main.secrets.minut || {}).y || !req.user || !req.query.code)
        return next();
    var locals = req.locals;
    chain(next, function () {
        request(locals.get = {
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

    }, function (resp, body) {
        locals.resp = resp;
        locals.body = body;
        res.type('text/plain').end(JSON.stringify(locals.json = {
            body: body,
        }));

    });
});

exports.all('/subscription/:type', function (req, res, next) { // GET /minuty/subscription/:type
    if (![req.headers.authorization, req.query.authorization].includes('nnFRbsysqTsqJDX4ViVchhuIApy0RLnQ'))
        return next();
    console.log('minuty-subscription:', { type: req.params.type, query: req.query, headers: req.headers, body: req.body });
    res.end();
});
