#!/bin/sh
# Fails if a private name appears in tracked file contents, file names or commit details.
# Usage: scripts/check-private-names.sh <file with one name per line, kept outside the repository>
# Run it before pushing: CI only sees what is already public.
set -u
names=${1:?names file}
[ -s "$names" ] || { echo "The names file is empty"; exit 2; }
bad=0
check() { # 0 found, 1 not found, anything else is an error
  case $1 in 0) bad=1 ;; 1) ;; *) echo "The check itself failed"; exit 2 ;; esac
}
git grep -liF --cached -f "$names"; check $?
git ls-files | grep -iF -f "$names"; check $?
git log --all --format='%an %ae %cn %ce %B' 2>/dev/null | grep -qiF -f "$names"; r=$?
[ $r -eq 0 ] && echo "In commit authors or messages"
check $r
[ $bad -eq 0 ] && echo "No private names found"
exit $bad
