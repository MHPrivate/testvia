while read; do
	cidr=${REPLY%%[$'\t' ]*}
	[ -z "$cidr" ] && continue
	echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
125.236.214.19/32	sean hadley dev
122.61.175.170/32	sean hadley dev
EOT
