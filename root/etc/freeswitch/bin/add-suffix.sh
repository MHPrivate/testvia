#! /bin/bash
if [ -e $1 ]; then
    /usr/bin/mv $1 ${1%.*}.${2}.${1##*.}
else
    /usr/bin/touch ${1%.*}.${2}.${1##*.}
fi
