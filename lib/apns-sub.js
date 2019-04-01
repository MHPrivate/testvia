#! /usr/bin/env node
if (!process.send) {
    console.log('This script is designed to communicate with a parent NodeJS process via IPC\n');
    console.log('Separation is necessary because the apn dependant node-forge is not strict clean\n');
    console.log('A parent process launches this script as:');
    console.log('   var sub = child_process.fork("bin/apns-sub.js", { execArgv: [] });');
    console.log('then, the parent:');
    console.log(' - receives IPC messages by registering a handler:\n   sub.on("message", (message, handle) => {})');
    console.log(' - sends IPC messages by calling:\n   sub.send(message[, sendHandle[, options]][, callback]);');
    console.log('\nnsee https://nodejs.org/docs/latest-v6.x/api/child_process.html#child_process_subprocess_send_message_sendhandle_options_callback');
    process.exit(1);
}

var apn = require('apn'); // v2.1.2 seems to work most cleanly

var secrets = JSON.parse(require('fs').readFileSync(process.env.SECRETS || __dirname + '/../secrets.json'), 'utf8');
if (secrets.apns.token.key.join)
    secrets.apns.token.key = secrets.apns.token.key.join('\n');

var providers = [false, true].map(function (sandbox, idx, arr) { // [ production, sandbox ]
    return new apn.Provider({
        token: secrets.apns.token,
        production: !sandbox,
    });
});

process.on('disconnect', function () {
    providers.forEach(function (provider, idx, arr) { provider.shutdown()});
});

process.on('message', function (message) { // { [devices], note:{badge,sound,alert,contentAvailable} }
    message.note.topic = secrets.apns.topic;
    message.count = 0;
    message.result = { sent: [], failed: [] };
    message.rigDevices.forEach(function (devices, idx, arr) { // idx[production, sandbox]
        if (!devices.length || !providers[idx])
            return;
        ++message.count;
        providers[idx].send(new apn.Notification(message.note), devices).then(function (result) {
            message.result.sent.push.apply(message.result.sent, result.sent);
            message.result.failed.push.apply(message.result.failed, result.failed);
            --message.count || process.send(message.result);
        });
    });
    message.count || process.send(message.result);
});
