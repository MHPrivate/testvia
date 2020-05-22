var chain = require('scope-chain');
var debug = require('debug')('locals');
var jwt = require('jsonwebtoken');
var main = require.main.exports;

module.exports = Object.assign(exports, {
    comment: comment,
    local: local,
    trusted: trusted,
    user: user,
});

function exports(req, res, next) {
    var cookie = req.secure ? req.cookies.jwts : req.cookies.jwt;
    if (!cookie)
        return next();
    chain(next, function () { // opportunistically parse the JWT-cookie if present
        jwt.verify(cookie, main.cache.tls.cert, { algorithms: ['RS256'] }, this);

    }, function (user) {
        if (user.secure !== req.secure)
            return this(Object.assign(new Error('jwt invalid'), { status: 400 }));
        req.user = user;
        req.headers.authorization = 'Basic ' + Buffer.from(user.username + ':').toString('base64'); // spoof the authorization header for morgan logging
        this();

    });
}

function local(req, res, next) {
    debug(req.index, 'local');
    next.index = req.index;
    if (req.socket.remoteAddress === req.socket.address().address) // e.g. '::ffff:51.254.118.61'
        return next();
    next('route');
};

function user(req, res, next) {
    if (typeof req === 'function')
        return function (req, res, next) {
            req.user && req.user.skills.length ? this.apply(null, arguments) : next('route');
        }.bind(req);

    debug(req.index, 'user', Boolean(req.user));
    next.index = req.index;
    req.user && req.user.skills.length ? next() : next('route');
};

function comment(comment) {
    return function (req, res, next) {
        console.log(req.index, comment);
        next();
    }
};

trusted.re = /^Bearer\s+(.*)/i;
function trusted(req, res, next) {
    debug(req.index, 'trusted');
    next.index = req.index;
    var authorization = (trusted.re.exec(req.headers.authorization) || [])[1];
    if (!((main.secrets.trusted || {})[authorization] || []).includes(req.ip))
        return res.sendStatus(404);
    next();
}
