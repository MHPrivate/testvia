cat <<EOT
firewall-cmd --perm --new-ipset=chums4 --type=hash:net --family=inet
firewall-cmd --perm --new-ipset=chums6 --type=hash:net --family=inet6
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="chums4" port port="5060" protocol="udp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="chums4" port port="5060-5061" protocol="tcp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="chums4" port port="5070" protocol="udp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv4" source ipset="chums4" port port="5070-5071" protocol="tcp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="chums6" port port="5060" protocol="udp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="chums6" port port="5060-5061" protocol="tcp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="chums6" port port="5070" protocol="udp" accept'
firewall-cmd --perm --add-rich-rule='rule family="ipv6" source ipset="chums6" port port="5070-5071" protocol="tcp" accept'

/opt/appello-via/bash/firewall-magrathea.sh | bash
/opt/appello-via/bash/firewall-magrathea.sh --perm | bash
/opt/appello-via/bash/firewall-scaip.sh | bash
/opt/appello-via/bash/firewall-scaip.sh --perm | bash
/opt/appello-via/bash/firewall-volt.sh | bash
/opt/appello-via/bash/firewall-volt.sh --perm | bash
EOT
