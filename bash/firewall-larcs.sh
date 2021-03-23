cat <<EOT
## define hash:ip larcs-config 
firewall-cmd --perm --new-ipset=larcs4 --type=hash:ip --family=inet
firewall-cmd --perm --new-ipset=larcs6 --type=hash:ip --family=inet6
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="larcs4" port port="5071" protocol="tcp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="larcs6" port port="5071" protocol="tcp" accept'
firewall-cmd --reload

echo 'main.modules.ipsets.sets.larcs.keeps={}' | rc /run/appello.sock

nft list set inet firewalld larcs4
EOT
