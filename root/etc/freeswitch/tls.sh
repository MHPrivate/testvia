#! /bin/bash
cat=/usr/bin/cat
chgrp=/usr/bin/chgrp
curl=/usr/bin/curl
dirname=/usr/bin/dirname
fs_cli=/usr/bin/fs_cli
ln=/usr/bin/ln
openssl=/usr/bin/openssl
rm=/usr/bin/rm
sleep=/usr/bin/sleep

check=dtls-srtp.pem
token=8a947e04-c590-4f6c-b40c-455e385e2ef2

umask 027
cd $(dirname $0)
dir=$(pwd)
[ -d tls ] || $ln -s /etc/pki/tls .
cd tls

old=$([ -e "$check" ] && openssl x509 -noout -serial -in $check)
for pem in key cert chain; do
    $curl -sH "Authorization: Bearer $token" https://localhost.appello.care/maintain/cert/appello.care?dir=$dir\&$pem >$$-$pem.pem
done

$cat $$-cert.pem $$-key.pem >agent.pem
$cat $$-chain.pem >cafile.pem
$cat $$-cert.pem $$-key.pem >dtls-srtp.pem #  just to be consistent though self-signed is likely suggicient
$cat $$-cert.pem $$-chain.pem $$-key.pem >tls.pem
$cat $$-cert.pem $$-chain.pem $$-key.pem >wss.pem

$rm -f $$-*.pem
$chgrp daemon agent.pem cafile.pem dtls-srtp.pem tls.pem wss.pem

[ -n "$noreload" ] && exit
[ "$old" == "$(openssl x509 -noout -serial -in $check)" ]  && exit

while sleep 1; do
    [ $(fs_cli -x status | grep -- '- peak' | cut -d ' ' -f 1) -eq 0 ] && break
done
$fs_cli -x 'unload mod_sofia'; $sleep 5; $fs_cli -x 'load mod_sofia'
