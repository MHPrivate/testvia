#! /bin/bash
cat=/usr/bin/cat
chgrp=/usr/bin/chgrp
curl=/usr/bin/curl
dirname=/usr/bin/dirname
fs_cli=/usr/bin/fs_cli
grep=/usr/bin/grep
jq=/usr/bin/jq
ln=/usr/bin/ln
openssl=/usr/bin/openssl
rm=/usr/bin/rm
sleep=/usr/bin/sleep
wc=/usr/bin/wc

check=dtls-srtp.pem
token=8a947e04-c590-4f6c-b40c-455e385e2ef2

umask 027
cd $(dirname $0)
dir=$(pwd)
[ -d tls ] || $ln -s /etc/pki/tls .
cd tls

old=$([ -e "$check" ] && openssl x509 -noout -serial -in $check)
declare -a empty
for pem in key cert chain; do
    $curl -sH "Authorization: Bearer $token" https://localhost.appello.care/maintain/cert/appello.care?dir=$dir\&$pem >$$-$pem.pem
    [ -s $$-$pem.pem ] || empty+=($$-$pem.pem)
done
[ ${#empty[*]} -gt 0 ] && echo "EMPTY: ${empty[*]}" && exit # protect against empty PEM file

$cat $$-cert.pem $$-key.pem >agent.pem
$cat $$-chain.pem >cafile.pem
$cat $$-cert.pem $$-key.pem >dtls-srtp.pem #  just to be consistent though self-signed is likely suggicient
$cat $$-cert.pem $$-chain.pem $$-key.pem >tls.pem
$cat $$-cert.pem $$-chain.pem $$-key.pem >wss.pem

$rm -f $$-*.pem
$chgrp daemon agent.pem cafile.pem dtls-srtp.pem tls.pem wss.pem

[ -n "$noreload" ] && exit
[ "$old" == "$(openssl x509 -noout -serial -in $check)" ]  && exit

## for each profile with 'tls' in the name
for profile in $($fs_cli -x 'sofia jsonstatus' | $jq -r '.profiles | keys[]' | $grep tls); do
  echo -n "$profile: "
  ## check no calls using said profile
  while $($fs_cli -x 'show calls as json' | $jq . | $grep -q $profile); do
    echo -n $($fs_cli -x 'show calls as json' | $jq . | $grep $profile | $wc -l)
    sleep 1
  done
  echo $fs_cli -x "sofia profile $profile restart"
  $fs_cli -x "sofia profile $profile restart"
  $sleep 10
done
exit


#while sleep 1; do
#    [ $(fs_cli -x status | grep -- '- peak' | cut -d ' ' -f 1) -eq 0 ] && break
#done
#$fs_cli -x 'unload mod_sofia'; $sleep 5; $fs_cli -x 'load mod_sofia'
