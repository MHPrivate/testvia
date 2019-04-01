var chain = require('scope-chain');
var debug = require('debug')('locals');
var extend = require('node.extend');
var jwt = require('jsonwebtoken');
var main = require.main.exports;

var reqs = global.reqs = extend([], { limit: 10, index: 0 });

module.exports = exports;
function exports(req, res, next) {
    req.index = ('000' + reqs.index++).slice(-3);
    (reqs.unshift(req) > reqs.limit) && (reqs.length = reqs.limit);
    req.locals = req.locals || {}; // general purpose stash for request processing
    var cookie = req.secure ? req.cookies.jwts : req.cookies.jwt;
    if (!cookie)
        return next();
    chain(next, function () { // opportunistically parse the JWT-cookie if present
        jwt.verify(cookie, main.cache.tls.cert, { algorithms: ['RS256'] }, this);

    }, function (user) {
        if (user.secure !== req.secure)
            return this(extend(new Error('jwt invalid'), { status: 400 }));
        req.user = user;
        req.headers.authorization = 'Basic ' + Buffer(user.username + ':').toString('base64'); // spoof the authorization header for morgan logging
        this();

    });
}

exports.local = function local(req, res, next) {
    debug(req.index, 'local');
    next.index = req.index;
    if (req.socket.remoteAddress === req.socket.address().address) // e.g. '::ffff:51.254.118.61'
        return next();
    next('route');
};

exports.user = function user(req, res, next) {
    if (typeof req === 'function')
        return function (req, res, next) {
            req.user && req.user.skills.length ? this.apply(null, arguments) : next('route');
        }.bind(req);

    debug(req.index, 'user', Boolean(req.user));
    next.index = req.index;
    req.user && req.user.skills.length ? next() : next('route');
};

exports.comment = function (comment) {
    return function (req, res, next) {
        console.log(req.index, comment);
        next();
    }
};
