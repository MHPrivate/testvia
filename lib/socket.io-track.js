module.exports = function exports(ms, soc, cb) {
    var id = soc.nsp.ids;
    function bound(err) {
        bound.timeout = clearTimeout(bound.timeout);
        cb && (cb = cb.apply(soc, arguments) && undefined);
    }
    bound.timeout = setTimeout(function () {
        bound.timeout = undefined;
        delete soc.acks[id];
        cb && (cb = cb(new Error('socket.io callback timeout')) && undefined);
    }, ms);
    return bound;
};
