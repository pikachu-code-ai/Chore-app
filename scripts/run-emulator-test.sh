#!/usr/bin/env bash
# Helper to run the emulator E2E test
# Usage: PROJECT_ID=your-project node tests/e2e-emulator.js

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "Please set PROJECT_ID environment variable. Example: PROJECT_ID=my-project node tests/e2e-emulator.js"
  exit 1
fi

node tests/e2e-emulator.js
