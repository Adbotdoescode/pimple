#!/usr/bin/env bash
# Stop any running Glass Tutor / tauri dev / vite.
pkill -f "target/debug/glass-tutor" 2>/dev/null
pkill -f "tauri dev" 2>/dev/null
pkill -f "node_modules/.bin/vite" 2>/dev/null
pkill -f "bun run dev" 2>/dev/null
lsof -ti tcp:1420 2>/dev/null | xargs kill 2>/dev/null
sleep 0.5
echo "stopped"
