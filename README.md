# appello-via
scheme connectivity service

This repo contains functionality to support scheme control and sip connectivity.

The functionality consists of a service to run under NodeJS on multiple cooperating servers in an N+M arrangement where:
- N is the number of live/operating servers necessary to support the required numbers of scheme
- M is a number of standby servers ready to adopt the active IP of a live/operating server in the a failure scenario.
