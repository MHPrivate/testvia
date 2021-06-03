while read; do
	cidr=${REPLY%%[$'\t' ]*}
	[ -z "$cidr" ] && continue
	echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
80.65.250.126/32		keith harris
EOT
