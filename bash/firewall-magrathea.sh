while read cidr other; do
echo $cidr:
firewall-cmd --perm --ipset=chums4 --add-entry=$cidr
done <<EOT
87.238.72.129/32
87.238.72.130/32
87.238.73.129/32
87.238.73.130/32
87.238.74.129/32
87.238.74.130/32
213.166.3.129/32
213.166.3.130/32
EOT
