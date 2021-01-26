while read; do
	cidr=${REPLY%%[$'\t' ]*}
	[ -z "$cidr" ] && continue
	echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
81.94.198.93/32		keith harris
EOT
