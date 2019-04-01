#! /usr/bin/bash
key=/etc/named.ddns.key
nsupdate=/usr/bin/nsupdate

#$nsupdate -l
$nsupdate -k $key
