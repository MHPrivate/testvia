while read cidr other; do
echo $cidr:
firewall-cmd --ipset=chums4 --add-entry=$cidr
done <<EOT
125.236.214.19/32
122.61.175.170/32
EOT
