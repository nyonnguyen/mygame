#!/bin/bash
# RetroWeb - Quick start script
set -e

echo "Building frontend..."
cd "$(dirname "$0")/frontend"
npm install --silent 2>/dev/null
npx vite build 2>/dev/null

echo "Building backend..."
cd "$(dirname "$0")"
source "$HOME/.cargo/env" 2>/dev/null || true
cargo build --release 2>&1 | tail -2

echo ""
echo "Starting RetroWeb on http://localhost:3000"
echo "ROM directory: ${ROM_DIR:-~/Documents/room-r36-plus}"
echo ""

RUST_LOG=info cargo run --release
