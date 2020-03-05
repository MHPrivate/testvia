var chain = require('scope-chain');
var express = require('express');
var main = require.main.exports;
var mysql = require('../../lib/mysql');

module.exports = exports = express.Router();

exports.get('/', function (req, res, next) { // GET /vi/sshkeys
    var locals = req.locals;
    next.index = req.index;
    chain(next, function () {
        mysql('select k.*,u.username from users u join userSkills s on s.userId=u.id join userSshs k on u.id=k.userId where s.skillName="ssha"', this);

    }, function (users, meta) { // {id,key,keyId,userId,username}
        locals.users = users;
        res.end(users.map(function (user, idx, arr) {
            return user.key + ' ' + user.username;
        }).join('\n') + '\n');

    });
});

exports.get('/:userId', function (req, res, next) { // GET /v1/sshkeys/:userId
    var locals = req.locals;
    next.index = req.index;
    chain(next, function () {
        mysql('select k.*,u.username from users u join userSkills s on u.id = s.userId join userSshs k on u.id = k.userId where(s.skillName = "ssha" or (k.userId=? and s.skillName="ssho")) group by id', [req.params.userId], this);

    }, function (users, meta) { // {id,key,keyId,userId,username}
        locals.users = users;
        res.end(users.map(function (user, idx, arr) {
            return user.key + ' ' + user.username;
        }).join('\n') + '\n');

    });
});

