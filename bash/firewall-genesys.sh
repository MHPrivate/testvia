while read; do
        cidr=${REPLY%%[$'\t' ]*}
        [ -z "$cidr" ] && continue
        echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
3.11.208.50
3.11.48.81
3.11.83.136
3.11.204.103
EOT
