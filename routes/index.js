var chain = require('scope-chain');
var express = require('express');
var jwt = require('jsonwebtoken');
var main = require.main.exports;
var mysql = require('../lib/mysql');

module.exports = exports = express.Router();

exports.use('/v1', require('./v1')); // service RESTful APIs v1
