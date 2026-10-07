#!/usr/bin/env bash
# Copy the extension to the folder Chrome on Windows loads unpacked from.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/extension"
win_user="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')"
dest="${1:-/mnt/c/Users/$win_user/Downloads/marginalia}"
mkdir -p "$dest"
rsync -a --delete "$src/" "$dest/"
echo "Synced to $dest. Reload the extension in chrome://extensions."
