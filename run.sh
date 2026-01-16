#!/bin/bash

# Run script for WebGL Weather Map SPA
# Usage: ./run.sh [dev|build|preview]

set -e

cd "$(dirname "$0")"

# Check if node_modules exists, if not install dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Default command is 'dev'
CMD="${1:-dev}"

case "$CMD" in
    dev)
        echo "Starting development server..."
        npm run dev -- --open
        ;;
    build)
        echo "Building for production..."
        npm run build
        ;;
    preview)
        echo "Previewing production build..."
        npm run build
        npm run preview -- --open
        ;;
    *)
        echo "Usage: $0 [dev|build|preview]"
        echo "  dev     - Start development server (default)"
        echo "  build   - Build for production"
        echo "  preview - Build and preview production build"
        exit 1
        ;;
esac
