#! /bin/bash
cat=/usr/bin/cat
curl=/usr/bin/curl
dirname=/usr/bin/dirname
fs_cli=/usr/bin/fs_cli
openssl=/usr/bin/openssl
token=8a947e04-c590-4f6c-b40c-455e385e2ef2

cd $(dirname $0)
umask 027

old=$([ -e agent.pem ] && openssl x509 -noout -serial -in agent.pem)
for pem in key cert chain; do
    $curl -sH "Authorization: Bearer $token" https://localhost.appello.care/maintain/cert/appello.care?$pem >$pem.pem
done

$cat cert.pem key.pem >agent.pem
$cat chain.pem >cafile.pem
$cat cert.pem chain.pem key.pem >wss.pem

## self-signed maybe sufficient, so leave untouched
$cat cert.pem key.pem >dtls-srtp.pem

[ "$old" == "$(openssl x509 -noout -serial -in agent.pem)" ]  && exit
$fs_cli -x 'reload mod_sofia'
