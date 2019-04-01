var chain = require('scope-chain');
var express = require('express');
var main = require.main.exports;
var mysql = require('../../lib/mysql');

module.exports = exports = express.Router();

exports.get('/', function (req, res, next) { // GET /vi/sshkeys
    var locals = req.locals;
    next.index = req.index;
    chain(next, function () {
        mysql('select u.* from users u join userSkills s on u.id=s.userId where u.sshKey is not null and s.skillName="ssh.all"', this);

    }, function (users, meta) {
        locals.users = users;
        res.end(users.map(function (user, idx, arr) {
            return user.sshKey + ' ' + user.username;
        }).join('\n') + '\n');

    });
});

exports.get('/:userId', function (req, res, next) { // GET /v1/sshkeys/:userId
    var locals = req.locals;
    next.index = req.index;
    chain(next, function () {
        mysql('select u.* from users u join userSkills s on u.id=s.userId where u.sshKey is not null and (s.skillName="ssh.all" or (u.id=? and s.skillName like "ssh%")) group by u.id', [req.params.userId], this);

    }, function (users, meta) {
        locals.users = users;
        res.end(users.map(function (user, idx, arr) {
            return user.sshKey + ' ' + user.username;
        }).join('\n') + '\n');

    });
});

