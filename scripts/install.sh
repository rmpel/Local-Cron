#!/usr/bin/env bash

###
# Package: Local Cron - Run WordPress cron from Local itself.
# Version: see package.json
# License: see README.md and LICENSE
# Author: Remon Pel
# URL: https://github.com/rmpel/Local-Cron/
###

# Installs the Cron add-on into Local by symlinking this folder into
# Local's addons directory and installing its dependencies.
set -euo pipefail

ADDON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
	Darwin) ADDONS_ROOT="$HOME/Library/Application Support/Local/addons" ;;
	Linux)  ADDONS_ROOT="$HOME/.config/Local/addons" ;;
	*) echo "On Windows, copy this folder to %AppData%\\Local\\addons and run 'npm install --omit=dev' inside it."; exit 1 ;;
esac

echo "Installing dependencies…"
cd "$ADDON_DIR"
npm install --include=dev --no-audit --no-fund

echo "Building…"
./node_modules/.bin/tsc

mkdir -p "$ADDONS_ROOT"
LINK="$ADDONS_ROOT/local-cron"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
	echo "ERROR: $LINK already exists and is not a symlink — remove it first." >&2
	exit 1
fi
ln -sfn "$ADDON_DIR" "$LINK"

echo
echo "Linked: $LINK -> $ADDON_DIR"
echo "Now restart Local, open Add-ons -> Installed, enable 'Cron', and relaunch."
