while read; do
        cidr=${REPLY%%[$'\t' ]*}
        [ -z "$cidr" ] && continue
        echo firewall-cmd $@ --ipset=chums4 --add-entry=$cidr
done <<EOT
178.22.139.77/32    lon.out.simwood.com
185.63.140.77/32    slo.out.simwood.com
185.63.142.77/32    man.out.simwood.com
195.10.99.99/32     chiptech
217.156.234.163/32  neatnovo
81.171.12.244/32    gw3.telealarm.com
85.133.122.73/32    essence + chiptech
85.214.144.155/32   gw1.telealarm.com
 87.86.190.25	    careip via CSL
94.23.55.219/32     gw2.telealarm.com
EOT

