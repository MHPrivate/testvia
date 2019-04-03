#! /usr/bin/bash
key=/etc/named.ddns.key
nsupdate=/usr/bin/nsupdate

#exec $nsupdate -l
exec $nsupdate -k $key
