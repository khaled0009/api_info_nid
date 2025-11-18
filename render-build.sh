#!/usr/bin/env bash
# exit on error
set -o errexit

STORAGE_DIR=/opt/render/project/.render

if [[ ! -d $STORAGE_DIR/chrome ]]; then
  echo "...Downloading Chrome"
  mkdir -p $STORAGE_DIR/chrome
  cd $STORAGE_DIR/chrome

  # Download Chrome
  wget -P ./ https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb

  # Extract Chrome (using the improved method)
  ar x google-chrome-stable_current_amd64.deb
  tar -xf data.tar.xz -C $STORAGE_DIR/chrome

  # Cleanup
  rm ./google-chrome-stable_current_amd64.deb data.tar.xz control.tar.* debian-binary

  cd $HOME/project/src
else
  echo "...Using Chrome from cache"
fi

# Install dependencies
echo "...Installing Chrome dependencies"
apt-get update && apt-get install -y \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libxss1 \
  xdg-utils \
  --no-install-recommends

# Show Chrome version for debugging
echo "Chrome version:"
$STORAGE_DIR/chrome/opt/google/chrome/google-chrome --version || echo "Chrome not found"

# Install Node dependencies
npm install