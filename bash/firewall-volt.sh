while read; do
        cidr=${REPLY%%[$'\t' ]*}
        [ -z "$cidr" ] && continue
        echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
195.110.86.158/32   volt-slough
213.219.9.138/32    volt-acton
EOT
