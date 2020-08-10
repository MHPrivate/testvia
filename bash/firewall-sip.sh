while read cidr other; do
echo $cidr:
firewall-cmd --perm --add-rich-rule="rule family=ipv4 source address=$cidr port port=5060 protocol=udp accept"
firewall-cmd --perm --add-rich-rule="rule family=ipv4 source address=$cidr port port=5061 protocol=tcp accept"
done <<EOT
185.63.140.77/32    slo.out.simwood.com
185.63.142.77/32    man.out.simwood.com
178.22.139.77/32    lon.out.simwood.com
85.133.122.73/32    essence
85.214.144.155/32   gw1.telealarm.com
94.23.55.219/32     gw2.telealarm.com
81.171.12.244/32    gw3.telealarm.com
217.156.234.163/32  neatnovo
EOT
