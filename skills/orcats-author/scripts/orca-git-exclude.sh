#!/usr/bin/env bash
# Install Orcats runtime-only patterns in Git's repository-local exclude file.
set -euo pipefail

repo="${1:-.}"
script_dir="$(cd "$(dirname "$0")" && pwd)"
patterns="$script_dir/../assets/runtime-scratch-patterns.txt"
[ -f "$patterns" ] || { echo "missing runtime scratch patterns: $patterns" >&2; exit 1; }

exclude="$(git -C "$repo" rev-parse --git-path info/exclude)"
case "$exclude" in /*) ;; *) exclude="$(cd "$repo" && pwd)/$exclude" ;; esac
mkdir -p "$(dirname "$exclude")"
[ -e "$exclude" ] || : > "$exclude"

missing=()
while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue
  grep -Fqx "$pattern" "$exclude" || missing+=("$pattern")
done < "$patterns"

if [ "${#missing[@]}" -gt 0 ]; then
  [ ! -s "$exclude" ] || printf '\n' >> "$exclude"
  printf '%s\n' "${missing[@]}" >> "$exclude"
fi
printf '%s\n' "$exclude"
