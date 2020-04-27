#! /bin/bash
ipset=/usr/sbin/ipset
nft=/usr/sbin/nft
table=firewalld

[ -x $nft ] || exec $ipset -! restore

# convert ipset commands to netfilter commands
while read cmd set ip; do
    case $cmd in
        add)
            $nft add element inet $table $set { $ip }
            ;;
        del)
            $nft delete element inet $table $set { $ip }
            ;;
        save)
            ;;
    esac
done
