# Module: <u>R</u>edis <u>P</u>ublish/<u>S</u>ubscribe <u>C</u>all<u>b</u>ack

This module wraps the public NPM `redis` module as a pair of connections, one for publishing (and DB access), the other for subscribing.

The module supplies a standard EventEmitter overloaded with the following attributes:

- defaultMs = 5000 - the default request round-trip timeout
- expires - the utcMs of the most imminent request timeout
- interval - the handle of the redis-ping keepalive
- pendings - a dictionary of pending requests {jobId=>job} 
- pub - the redis connection for publishing and database access
- publish([ms], 'channel', [args, ...], cb(err, outstanding, ...)) - the publication method
- ready - a Promise that is fulfilled once both redis-connections are established
- sub - the redis connection for subscribing
- timeout - the handle of the most imminent request timeout
- uuid() - a uuid-v1 generator method

The EventEmitter monitors added and removed listeners and automatically subscribes/unsubscribes the given channel-name

## Startup

The `rpcsb` module awaits the process.running Promise from the `running` module before initiating connections.

Connections are established using config defined on `main.secrets.redis` formatted as shown below:

```
{
    "url": "rediss://:<password>@<hostname>:<port>",
    "retry_unfulfilled_commands": true,
    "socket_keepalive": true
},
```

TLS encrypted connections are used where the uri defines the `rediss:` schema, while unencrypted connections are used where the uri defines the `redis:` schema. 

Once both the `pub` and `sub` connections are ready, the exported `ready` Promise is fulfilled for triggering user-defined followup operations.

## Usage

### Publishing

Calls to the supplied `publish` method wrap any arguments in a JSON object and publish it to the named-channel.

e.g.
```
    // extend the default timeout to 10s by suppling it as the optional 1st arg
    rpscb.publish(10000, 'party', function (err, outs, result) {
        if (err)
            return console.log('outstanding:', outs, err);

        console.log('outstanding:', outs, result);
    });
```

Where the `publish` is called with a callback, the sent JSON object is augmented with a transient channel-name to receive recipient responses.

When supplied, the `publish` callback is called multiple times, once for each recipient that responds and/or reporting any final timed-out responses. The `outstanding` count argument supplied on each invoke indicates the number of remaining of responses, or zero where remaining responses have timed-out.

The `publish` method returns a `job` object which should not be externally modified. For interest, the `job` object has the following attributes:

- await - count of outstanding responses
- channel - the publication channel-name
- date - the Date of the initial request or most recent response
- fn - the callback passed to `publish`
- ms - the incremental timeout from the most recent activity

If there are no listeners for a published channel-name, the callback will be invoked immediately indicating none outstanding.

The per-request timeout is restarted by each received response, ultimately timing-out all remaining responses N(ms) after the last received response.

For example, were a publish-with-callback to land with four recipients, but two failed to respond, the callback would be invoked as follows:

- cb(null, 3, ...) // first responder within 5000ms of initial publish
- cb(null, 2, ...) // second responder within 5000ms of first response
- cb(Error('rpscb timeout'), 0) // third & fourth responder timeout 5000ms after second response.

### Subscribing

Received publications are emitted on the module's EventEmitter against the published channel-name along with any supplied args.

Publications that are expected to respond will carry a locally defined trailing callback arg.

e.g.
```
    rpscb.on('party', function (/* [arg, ...], ?cb */) { // optional args and cb
        if (typeof arguments[arguments.length - 1] !== 'function') // no response expected
            null;
        else if (true) // response expected - indicate success
            cb(null, 'dancing');
        else // response expected - indicate failure
            cb(new Error('funeral'));
    });
```

The supplied callback has in-built protection against being called multiple times.

