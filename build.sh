#!/bin/bash
set -e

# Format and lint
npm run format
npm run lint

# Build main bundle
npx esbuild src/main.ts \
  --bundle \
  --outfile=dist/bundle.js \
  --format=iife \
  --platform=browser \
  --target=es2020 \
  --sourcemap \
  --minify

# Build bulk bundle
npx esbuild src/bulk.ts \
  --bundle \
  --outfile=dist/bulk-bundle.js \
  --format=iife \
  --platform=browser \
  --target=es2020 \
  --sourcemap \
  --minify

# Build bulk-serial bundle
# Note: meshcore.js includes Node.js-only modules (TCP, serialport, etc.)
# that we don't need for Web Serial, so mark them as external
npx esbuild src/bulk-serial.ts \
  --bundle \
  --outfile=dist/bulk-serial-bundle.js \
  --format=iife \
  --platform=browser \
  --target=es2020 \
  --sourcemap \
  --minify \
  --external:net \
  --external:stream \
  --external:util \
  --external:fs \
  --external:events \
  --external:child_process \
  --external:@serialport/*

# Build radio-config bundle
npx esbuild src/radio-config.ts \
  --bundle \
  --outfile=dist/radio-config-bundle.js \
  --format=iife \
  --platform=browser \
  --target=es2020 \
  --sourcemap \
  --minify \
  --external:net \
  --external:stream \
  --external:util \
  --external:fs \
  --external:events \
  --external:child_process \
  --external:@serialport/*

# Build raw-packets bundle
npx esbuild src/raw-packets.ts \
  --bundle \
  --outfile=dist/raw-packets-bundle.js \
  --format=iife \
  --platform=browser \
  --target=es2020 \
  --sourcemap \
  --minify \
  --external:net \
  --external:stream \
  --external:util \
  --external:fs \
  --external:events \
  --external:child_process \
  --external:@serialport/*

# Build network-finder bundle
npx esbuild src/network-finder.ts \
  --bundle \
  --outfile=dist/network-finder-bundle.js \
  --format=iife \
  --platform=browser \
  --target=es2020 \
  --sourcemap \
  --minify \
  --external:net \
  --external:stream \
  --external:util \
  --external:fs \
  --external:events \
  --external:child_process \
  --external:@serialport/*

# Copy HTML and CSS to dist (wordlist is now bundled in the library)
cp index.html bulk.html bulk-serial.html radio-config.html raw-packets.html network-finder.html styles.css dist/
