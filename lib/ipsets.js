var debug = require('debug')('ipsets');
var chain = require('scope-chain');
var extend = require('node.extend');
var main = require.main.exports;
var spawn = require('child_process').spawn;

module.exports = extend(exports, {
    cmd: null,
    init: init,
    sets: {}, // larcs/mirrors/... => { drops: { ipstr => Date }, keeps: { ipstr => Date } } 
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
        if (main.setup.https !== 443) // only flush if servicing port:443
            return;
        exports.cmd.stdin.write('flush larcs4\nflush larcs6\n', 'utf8');

    });
}

process.once('terminate', function _ipsets() {
    exports.timeout = clearTimeout(exports.timeout);
    exports.cmd && exports.cmd.stdin.end();
});

process.on('larcPresent', exports.bind(exports, 'larcs', 0));
process.on('larcDropped', exports.bind(exports, 'larcs', 30000));
function exports(base, ms, ipstr) {
    exports.sets[base] || (exports.sets[base] = { drops: {}, keeps: {} });
    var familySet = base + (ipstr.includes(':') ? '6' : '4');
    if (!ipstr) {
        null;
    } else if (ms) {
        debug('drop:', familySet, ipstr);
        exports.sets[base].drops[ipstr] = new Date(Date.now() + ms);
        exports.timeout || (exports.timeout = main.running && setTimeout(onTimeout, ms));
    } else if (exports.sets[base].drops[ipstr]) {
        debug('keep:', familySet, ipstr);
        exports.sets[base].keeps[ipstr] = new Date;
        delete exports.sets[base].drops[ipstr];
    } else if (exports.sets[base].keeps[ipstr]) {
        debug('here:', familySet, ipstr);
        exports.sets[base].keeps[ipstr] = new Date;
   } else {
        debug('land:', familySet, ipstr);
        exports.cmd && exports.cmd.stdin.write('add ' + familySet + ' ' + ipstr + '\nsave ' + familySet + '\n', 'utf8');
        exports.sets[base].keeps[ipstr] = new Date;
    }
}

function onTimeout() {
    var next, now = new Date;
    for (var base in exports.sets) { // base: larcs/mirrors/...
        var ipSet = exports.sets[base];
        for (var ipstr in ipSet.drops) { // ipstr: <ipv4/ipv6>
            var familySet = base + (ipstr.includes(':') ? '6' : '4');
            if (ipSet.drops[ipstr] <= now) {
                debug('dropped:', familySet, ipstr);
                exports.cmd && exports.cmd.stdin.write('del ' + familySet + ' ' + ipstr + '\nsave ' + familySet + '\n', 'utf8');
                delete ipSet.keeps[ipstr];
                delete ipSet.drops[ipstr];
            } else if (!next || next > ipSet.drops[ipstr]) {
                next = ipSet.drops[ipstr];
            }
        }
    }
    exports.timeout = next ? setTimeout(onTimeout, new Date - next) : clearTimeout(exports.timeout);
}

/*
firewall-cmd --perm --new-ipset=larcs4 --type=hash:ip --family=inet
firewall-cmd --perm --new-ipset=larcs6 --type=hash:ip --family=inet6
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="larcs4" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="larcs6" port port="5071" protocol="tcp" accept'

firewall-cmd --perm --remove-rich-rule='rule family="ipv6" source ipset="larcs6" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --remove-rich-rule='rule family="ipv4" source ipset="larcs4" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --delete-ipset=larcs6 --type=hash:ip --family=inet6
firewall-cmd --perm --delete-ipset=larcs4 --type=hash:ip --family=inet
*/
