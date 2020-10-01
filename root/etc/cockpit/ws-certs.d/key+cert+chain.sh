#! /bin/bash
cd $(dirname $0)
dir=$(pwd)
token=8a947e04-c590-4f6c-b40c-455e385e2ef2
/usr/bin/curl -sH "Authorization: Bearer $token" https://localhost.appello.care/maintain/cert/appello.care?dir=$dir >$(dirname $0)/$(basename $0 .sh).cert
