#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
node src/poller.js 2>&1 | tee -a logs/poller.log
