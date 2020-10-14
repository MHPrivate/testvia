#! /bin/bash
exec /usr/bin/mv $1 ${1%.*}.${2}.${1##*.}
