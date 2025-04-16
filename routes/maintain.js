var chain = require('scope-chain');
var express = require('express');
var locals = require('../lib/locals');
var main = require.main.exports;
var mysql = require('../lib/mysql');
var router = module.exports = express.Router();

router.get('/cert/appello.care', locals.trusted, function (req, res, next) {
    next.index = req.index;
    var locals = Object.assign(req.locals, { chunks: [], map: { key: 'privkey', cert: 'cert', chain: 'chain' } });
    if (!['key', 'cert', 'chain'].some(function (e, i, a) { return e in this }, req.query)) // empty shopping list means everything
        req.query = { key: '', cert: '', chain: '' };
    chain(next, function () {
        mysql('select *,l.chain from fqdns f left join leChains l on f.chainId=l.id where fqdn=?', [main.secrets.fqdn || 'appello.care'], this);

    }, function (fqdns, meta) {
        locals.fqdns = fqdns;
        if (!fqdns.length)
            res.sendStatus(404);
        locals.fqdn = fqdns[0];
        locals.chunks.push([req._startTime.toJSON(), main.identity, req.ip].join(' ') + '\n');
        for (var chunk in req.query)
            locals.fqdn[locals.map[chunk]] && locals.chunks.push(locals.fqdn[locals.map[chunk]]);
        res.type('text/plain').end(locals.chunks.join(''));

    });
});
