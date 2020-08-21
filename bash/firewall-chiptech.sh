while read cidr other; do
echo $cidr:
firewall-cmd --add-rich-rule="rule family=ipv4 source address=$cidr port port=5060 protocol=udp accept"
firewall-cmd --add-rich-rule="rule family=ipv4 source address=$cidr port port=5060 protocol=tcp accept"
firewall-cmd --add-rich-rule="rule family=ipv4 source address=$cidr port port=5061 protocol=tcp accept"
firewall-cmd --add-rich-rule="rule family=ipv4 source address=$cidr port port=5070 protocol=udp accept"
firewall-cmd --add-rich-rule="rule family=ipv4 source address=$cidr port port=5070 protocol=tcp accept"
firewall-cmd --add-rich-rule="rule family=ipv4 source address=$cidr port port=5071 protocol=tcp accept"
done <<EOT
125.236.214.19/32
122.61.175.170/32
EOT
