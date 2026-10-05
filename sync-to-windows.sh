#!/usr/bin/env bash
# Copy the extension to the folder Chrome on Windows loads unpacked from.
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)"
dest="/mnt/c/Users/murehman/Downloads/marginalia"
mkdir -p "$dest"
rsync -a --delete --exclude '.git' --exclude 'dev' --exclude '*.sh' "$src/" "$dest/"
echo "Synced to $dest. Reload the extension in chrome://extensions."
