#!/usr/bin/env bash

###
# Package: Local Cron - Run WordPress cron from Local itself.
# Version: see package.json
# License: see README.md and LICENSE
# Author: Remon Pel
# URL: https://github.com/rmpel/Local-Cron/
###

#
# build.sh — package Cron as a distributable Local (LocalWP) add-on.
#
# Local add-ons ship as a folder that the user drops into Local's addons
# directory. That folder must be self-contained: source + a *production-only*
# node_modules (Local does not run `npm install` for the user). This script
# stages exactly those files, installs prod dependencies cleanly, and packages the
# result to dist/<slug>-v<version>.tgz, unpacking to a top-level folder named
# after the package (the same name install.sh symlinks).
#
set -euo pipefail

cd "$(dirname "$0")"/.. || exit 1
ROOT=$(pwd -P)

# --- read identity from package.json (node is guaranteed present here) --------
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
PRODUCT="$(node -p "require('./package.json').productName || require('./package.json').name")"

STAGE="$ROOT/build"
PKG_DIR="$STAGE/$NAME"
DIST="$ROOT/dist"
ZIP="$DIST/${NAME}-v${VERSION}.tgz"

echo "==> Building $PRODUCT v$VERSION"

echo "==> Compiling TypeScript"
# npx would fall back to the unrelated, deprecated "tsc" npm package when
# typescript is not installed locally - always use the project-local binary.
if [ ! -x node_modules/.bin/tsc ]; then
	npm install --include=dev --no-audit --no-fund
fi
./node_modules/.bin/tsc

# --- clean ---------------------------------------------------------------------
rm -rf "$STAGE" "$ZIP"
mkdir -p "$PKG_DIR" "$DIST"

# --- stage the files that ship in the add-on ----------------------------------
# Everything the add-on needs at runtime, plus license/readme. Explicitly NOT:
# node_modules (installed fresh below), test/, dist/, build/, .git, dotfiles.
echo "==> Staging files"
cp -R lib src "$PKG_DIR/"
cp package.json package-lock.json icon.svg README.md LICENSE "$PKG_DIR/"

# Keep the installer helper so a folder-drop install still has it (optional).
if [ -d scripts ]; then
	cp -R scripts "$PKG_DIR/"
fi

# --- install production dependencies into the staged copy ---------------------
echo "==> Installing production dependencies"
(
	cd "$PKG_DIR"
	if [ -f package-lock.json ]; then
		npm ci --omit=dev --no-audit --no-fund
	else
		npm install --omit=dev --no-audit --no-fund
	fi
)

# --- sanity check: no dev/junk leaked in --------------------------------------
if [ ! -d "$PKG_DIR/node_modules" ]; then
	echo "ERROR: node_modules missing after install — aborting." >&2
	exit 1
fi

# --- zip (archive contains a single top-level "<name>/" folder) ---------------
echo "==> Creating archive"
(
	cd "$STAGE"
	tar --exclude='.DS_Store' --exclude='.git' --exclude='npm-debug.log' -zcf "$ZIP" "$NAME"
)

SIZE="$(du -h "$ZIP" | cut -f1)"
echo
echo "==> Done: $ZIP  ($SIZE)"
echo "    Install: In LocalWP Select install from disk, then select the .tgz file"
echo "    and enable '$PRODUCT' under Add-ons -> Installed."
