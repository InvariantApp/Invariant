#!/usr/bin/env bash
# The pinned gitleaks release, verified against its published checksums.
set -euo pipefail
VERSION=8.30.1
DIR=${1:-.cache/gitleaks}
mkdir -p "$DIR"
cd "$DIR"
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"
curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/gitleaks_${VERSION}_checksums.txt" \
  | grep " ${ARCHIVE}$" | sha256sum -c -
tar xzf "$ARCHIVE" gitleaks
