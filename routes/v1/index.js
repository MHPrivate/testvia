var express = require('express');

module.exports = exports = express.Router();

exports.use('/larc', require('./larc'));
exports.use('/mosh', require('./mosh'));
exports.use('/sshkeys', require('./sshkeys'));

exports.get('/', function (req, res, next) { // GET /v1 - list API catalogue
    if (!req.user)
        return next();
    res.type('text/plain').end([
        'GET /v1 - this API list',
        'POST /v1/larc - create/update larc entry',
        'GET /v1/sshkeys - fetch authorized_keys file with masters keys',
        'GET /v1/sshkeys/:userId - fetch authorized_keys file with masters + given userId keys',
        'GET /v1/mosh {moshPort, moshSecret} - supply mosh-server secret'
    ].join('\n') + '\n');
});
