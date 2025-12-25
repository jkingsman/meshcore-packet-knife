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

# Copy HTML files to dist
cp index.html bulk.html dist/
