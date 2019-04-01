var debug = require('debug')('ipsets');
var chain = require('scope-chain');
var extend = require('node.extend');
var main = require.main.exports;
var spawn = require('child_process').spawn;

module.exports = extend(exports, {
    cmd: null,
    drops: {}, // ipstr => utcMs
    init: init,
    keeps: {}, // ipstr => utcMs
    timeout: null,
});
Object.defineProperties(exports, {
    cmd: { enumerable: false },
    init: { enumerable: false },
});

process.once('running', init);
function init(force) {
    if (main.setup.https !== 443 && !force)
        return;
    chain(function cleanup(err, code, signal) {
        exports.cmd = undefined;
        if (err)
            return console.log('ipsets:', err)
        debug('cleanup: code =', code, 'signal =', signal);

    }, function () {
        exports.cmd = spawn(__dirname + '/../bash/ipset-restore.sh', { stdio: ['pipe', 'ignore', process.stderr] });
        exports.cmd.on('error', this); // delivers: (err)
        exports.cmd.on('close', this.bind(null, null)); // delivers: (null, code, signal)
        if (main.setup.https === 443) // only flush if servicing port:443
            exports.cmd.stdin.write('flush sips4\nflush sips6\n', 'utf8');

    });
}

process.once('terminate', function _ipsets() {
    exports.timeout = clearTimeout(exports.timeout);
    exports.cmd && exports.cmd.stdin.end();
});

process.on('larcPresent', exports.bind(exports, 0));
process.on('larcDropped', exports.bind(exports, 30000));
function exports(ms, ipstr) {
    debug(ms ? 'drop:' : 'here:', ipstr);
    var ipset = ipstr.includes(':') ? 'sips6' : 'sips4';
    if (!ipstr) {
        null;
    } else if (ms) {
        exports.drops[ipstr] = Date.now() + ms;
        exports.timeout || (exports.timeout = setTimeout(onTimeout, ms));
    } else {
        exports.cmd && exports.cmd.stdin.write('add ' + ipset + ' ' + ipstr + '\nsave ' + ipset + '\n', 'utf8');
        exports.keeps[ipstr] = Date.now();
        exports.drops[ipstr] && delete exports.drops[ipstr];
    }
}

function onTimeout() {
    var nextMs = 0;
    Object.keys(exports.drops).forEach(function (ipstr, idx, arr) {
        var ipset = ipstr.includes(':') ? 'sips6' : 'sips4';
        if (this[ipstr] <= Date.now()) {
            debug('dropped:', ipstr);
            exports.cmd && exports.cmd.stdin.write('del ' + ipset + ' ' + ipstr + '\nsave ' + ipset + '\n', 'utf8');
            delete exports.keeps[ipstr];
            delete this[ipstr];
        } else if (!nextMs || nextMs > this[ipstr]) {
            nextMs = this[ipstr];
        }
    }, exports.drops);
    exports.timeout = nextMs ? setTimeout(onTimeout, Date.now() - nextMs) : clearTimeout(exports.timeout);
}

/*
firewall-cmd --perm --new-ipset=sips4 --type=hash:ip --family=inet
firewall-cmd --perm --new-ipset=sips6 --type=hash:ip --family=inet6
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="sips4" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="sips6" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --remove-rich-rule='rule family="ipv4" source ipset="sips4" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --remove-rich-rule='rule family="ipv6" source ipset="sips6" port port="5071" protocol="tcp" accept'
*/