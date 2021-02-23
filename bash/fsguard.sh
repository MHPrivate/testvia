#! /bin/bash
# Script to add source IPs of failed freeswitch authentications to a systemwide droplist
date=/usr/bin/date
dmesg=/usr/bin/dmesg
echo=/usr/bin/echo
firewall=/usr/bin/firewall
fs_cli=/usr/bin/fs_cli
grep=/usr/bin/grep
jq=/usr/bin/jq
nft=/usr/sbin/nft
null=/dev/null
sed=/usr/bin/sed

exit=0
for ver in 4 6; do
    $nft list set inet firewalld drop${ver} >$null && continue
    $echo Error: missing netfilter-set drop${ver} 
    exit=1
done
[ $exit -gt 0 ] && exit $exit

recreate () {
    $nft list set inet firewalld drop${1} | $grep -q timeout && return
    $echo recreating drop${1} with timeout feature
    $nft delete set inet firewalld drop${1}
    $nft add set inet firewalld drop${1} { type ipv${1}_addr\; flags interval,timeout\; timeout 1h\; }
    $nft insert rule inet firewalld filter_INPUT ip${1%4} saddr @drop${1} drop
}

for ver in 4 6; do
    recreate $ver
done

#script="/SIP auth failure/{s/^.*for \[//;s/@.*from ip//;p}" # incorrect username or password
script="/Can't find user/{s/^.*user \[//;s/@.*from//;p}" #incorrect username only

### explanation
# dmesg | grep      - create a silent stdin for fs_cli to only deliver logging
# fs_cli | sed      - generates lines of "<user> <ip>" that failed authentication
$dmesg -w | $grep -v . | $fs_cli -irRd 0 -l 4 | $sed -un "$script" | while read user ip; do
    # identify ipv4 or ipv6
    ver=$([[ "$ip" == *:* ]] && $echo 6 || $echo 4)
    # check if the IP is already blacklisted
    ($nft -j list set inet firewalld drop${ver} | $jq .nftables[1].set.elem | $grep -q $ip) && continue
    # check for whitelisted IPs
    [ $($fs_cli -x "acl $ip whitelist") == true ] && continue
    # log the nft command
    $echo nft add element inet firewalld drop${ver} {$ip timeout 1h} \# $user $($date +%T.%N)
    # execute the nft command
    $nft add element inet firewalld drop${ver} {$ip timeout 1h} \# $user && continue
    # recreate the nft set
    recreate ${ver}
    # log the nft command
    $echo nft add element inet firewalld drop${ver} {$ip timeout 1h} \# $user $($date +%T.%N) retry
    # retry nft command
    $nft add element inet firewalld drop${ver} {$ip timeout 1h} \# $user
done

exit

#1 permenantly create & activate drop4
firewall-cmd --quiet --perm --new-ipset=drop4 --type=hash:ip --family=inet && # permenantly create drop4
    firewall-cmd --quiet --perm --zone=drop --add-source=ipset:drop4 # permenantly assign drop4 to drop zone

#2 permenantly create & activate drop6
firewall-cmd --quiet --perm --new-ipset=drop6 --type=hash:ip --family=inet6 && # permenantly create drop6
    firewall-cmd --quiet --perm --zone=drop --add-source=ipset:drop6 # permenantly assign drop6 to drop zone

#3 reload
firewall-cmd --quiet --reload # reload


#1 persistently delete drop4
firewall-cmd --quiet --perm --zone=drop --remove-source=ipset:drop4 && # permenantly cease usage of drop4
    firewall-cmd --quiet --perm --delete-ipset=drop4 # permenantly delete drop4

#2 persistently delete drop6
firewall-cmd --quiet --perm --zone=drop --remove-source=ipset:drop6 && # permenantly cease usage of drop6
    firewall-cmd --quiet --perm --delete-ipset=drop6 # permenantly delete drop6

#3 reload
firewall-cmd --quiet --reload # reload
