#! /usr/bin/env node-strict
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var express = require('express');
var extend = require('node.extend');
var main = require.main.exports;
var morgan = require('morgan');
var statuses = require('statuses');
var util = require('util');

var errs = global.errs = extend([], { limit: 10 });

module.exports = exports = express();

// view engine setup
exports.set('views', __dirname + '/../views');
exports.set('view engine', 'ejs');
exports.engine('html', require('ejs').renderFile);

exports.use(bodyParser.json());
exports.use(bodyParser.urlencoded({ extended: false }));
exports.use(cookieParser());
exports.use(morgan('combined'));

var locals = require('./locals');
exports.use(locals); // index, locals, jwt(s)
exports.use(require('../routes')); // individually secured as necessary
exports.use(locals.user(express.static(__dirname + '/../static/secure'))); // sanctioned users only
exports.use(locals.user(express.static('/tmp/appello'))); // sanctioned users only
exports.use(express.static(__dirname + '/../static/public')); // open to the masses

// catch 404 and forward to error handler
exports.use(function (req, res, next) {
    next(extend(new Error(statuses[404]), { status: 404 }));
});

// error handler
exports.use(function (err, req, res, next) {
    err.status = err.status || 500;
    if (err.status !== 404) {
        console.error(err.stack || err);
        (errs.unshift(err) > errs.limit) && (errs.length = errs.limit);
        err.req = req;
    }

    res.status(err.status);
    res.format({
        'text/plain': function () {
            res.send((process.stdin.isTTY ? util.inspect(err) : statuses[err.status]) + '\n');
        },

        'text/html': function () {
            res.render('error.html', {
                req: req,
                main: main,
                status: err.status,
                message: err.message,
                error: err.status !== 404 && process.stdin.isTTY && err,
            });
        },

        'application/json': function () {
            res.json({ error: statuses[err.status], status: err.status });
        },

        'default': function () {
            // log the request and respond with 406
            res.status(406).send('Not Acceptable');
        }
    });
});
