while read; do
	cidr=${REPLY%%[$'\t' ]*}
	[ -z "$cidr" ] && continue
	echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
104.40.178.187/32       production1
52.232.85.155/32        production2
213.199.130.48/32       testing
 5.56.114.121/32         eugin home
EOT
