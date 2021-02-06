#! /bin/bash
# Script to add source IPs of failed freeswitch authentications to a systemwide droplist
dmesg=/usr/bin/dmesg
echo=/usr/bin/echo
firewall=/usr/bin/firewall
fs_cli=/usr/bin/fs_cli
grep=/usr/bin/grep
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

for ver in 4 6; do
    $nft list set inet firewalld drop${ver} | $grep -q timeout && continue
    $echo recreating drop${ver} with timeout feature
    $firewall-cmd --quiet --zone=drop --remove-source=ipset:drop${ver}
    $nft delete set inet firewalld drop${ver}
    $nft add set inet firewalld drop${ver} { type ipv${ver}_addr\; flags timeout\; timeout 1h\; }
    $firewall-cmd --quiet --zone=drop --add-source=ipset:drop${ver}
done

#script="/SIP auth failure/{s/^.*for \[//;s/@.*from ip//;p}" # incorrect username or password
script="/Can't find user/{s/^.*user \[//;s/@.*from//;p}" #incorrect username only

### explanation
# dmesg | grep      - create a silent stdin for fs_cli to only deliver logging
# fs_cli | sed      - generates lines of "<user> <ip>" that failed authentication
$dmesg -w | $grep -v . | $fs_cli -irRd 0 -l 4 | $sed -un "$script" | while read user ip; do
    # check for whitelisted IPs
    [ $($fs_cli -x "acl $ip whitelist") == true ] && continue
    # identify ipv4 or ipv6
    ver=$([[ "$ip" == *:* ]] && $echo 6 || $echo 4)
    # log the nft command
    $echo nft add element inet firewalld drop${ver} {$ip timeout 1h} \# $user
    # execute the nft commant
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
