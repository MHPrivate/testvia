# appello-via
scheme connectivity service

This repo contains functionality to support scheme control and sip connectivity.

The functionality consists of a service to run under NodeJS on multiple cooperating servers in an L+R arrangement where:
- L is the number of (L)ive/operational servers necessary to support the required numbers of scheme
- R is a number of (R)eserve/standby servers ready to adopt the active IP of a failed Live/operational server.

To maintain loose coupling between functional areas, this codebase uses the 'running' module to publish _running_ and
_terminate_ events on the process Emitter to signal:
- running - all code loaded - begin operation
- terminate - process terminating - cleanup all event-loop participation

When run from the command-line (where STDIN is a TTY), a console-repl is started.

When run as a service (where STDIN is not a TTY), a _replify_ unix-socket is placed at /run/appello.sock for use by with
the replify-client, allowing interaction with the service daemon.
