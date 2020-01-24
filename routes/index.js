var chain = require('scope-chain');
var express = require('express');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mysql = require('../lib/mysql');

module.exports = exports = express.Router();

exports.use('/minuty', require('./minuty'));
exports.use('/minutz', require('./minutz'));
exports.use('/v1', require('./v1')); // service RESTful APIs v1

exports.get('/webauthn', function (req, res, next) {
    if (!req.user)
        return next();
    var locals = {
        main: main,
        req: req,
    };
    res.type('text/html').render('webauthn.html', locals);
});
