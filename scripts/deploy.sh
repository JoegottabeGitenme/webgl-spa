#!/usr/bin/env bash
#
# WebGL SPA - Production Deployment
# =============================================================================
# Deploys the WebGL Weather SPA to a remote server with:
#   - Docker image build and transfer
#   - Joins the shared-services Docker network (gateway handles routing)
#
# Usage:
#   ./scripts/deploy.sh              # Full deployment
#   ./scripts/deploy.sh --update     # Update app (rebuild & redeploy)
#   ./scripts/deploy.sh --rebuild    # Force rebuild and redeploy
#   ./scripts/deploy.sh --status     # Check deployment status
#   ./scripts/deploy.sh --logs       # View app logs
#   ./scripts/deploy.sh --ssh        # SSH to remote server
#   ./scripts/deploy.sh --help       # Show help
#
# Prerequisites:
#   - .env.app file configured (copy from .env.app.example)
#   - SSH key access to remote server
#   - Docker installed locally and on remote server
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.app"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_step()    { echo -e "${CYAN}[STEP]${NC} $1"; }

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

show_help() {
  cat << 'EOF'
WebGL SPA - Production Deployment

Usage:
  ./scripts/deploy.sh [command]

Commands:
  (none)        Full deployment (first time or complete redeploy)
  --update      Rebuild and redeploy the app
  --rebuild     Force full rebuild and redeploy
  --status      Check deployment status on remote
  --logs        View container logs
  --ssh         SSH to remote server
  --help        Show this help

Prerequisites:
  1. Copy .env.app.example to .env.app and fill in your values
  2. Set up SSH key access to your server
  3. Ensure Docker is installed on the remote server
  4. Ensure shared-services network exists on remote (created by gateway stack)

Example:
  # First deployment
  cp .env.app.example .env.app
  # Edit .env.app with your settings
  ./scripts/deploy.sh

  # Later updates
  ./scripts/deploy.sh --update      # Rebuild and redeploy

EOF
}

ssh_cmd() {
  ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$REMOTE_HOST" "$@"
}

scp_cmd() {
  scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new "$@"
}

# =============================================================================
# PHASE 1: LOAD & VALIDATE CONFIGURATION
# =============================================================================

load_config() {
  log_step "Phase 1: Loading configuration..."

  if [[ ! -f "$ENV_FILE" ]]; then
    log_error "Configuration file not found: $ENV_FILE"
    echo ""
    echo "Please create it from the example:"
    echo "  cp .env.app.example .env.app"
    echo "  # Edit .env.app with your settings"
    echo ""
    exit 1
  fi

  # Source the config
  set -a
  source "$ENV_FILE"
  set +a

  # Validate required fields
  local missing=()
  [[ -z "${REMOTE_HOST:-}" ]] && missing+=("REMOTE_HOST")
  [[ -z "${SSH_KEY_PATH:-}" ]] && missing+=("SSH_KEY_PATH")
  [[ -z "${REMOTE_DIR:-}" ]] && missing+=("REMOTE_DIR")

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "Missing required configuration:"
    for field in "${missing[@]}"; do
      echo "  - $field"
    done
    echo ""
    echo "Please edit $ENV_FILE and fill in the required values."
    exit 1
  fi

  # Expand SSH key path
  SSH_KEY_PATH="${SSH_KEY_PATH/#\~/$HOME}"

  if [[ ! -f "$SSH_KEY_PATH" ]]; then
    log_error "SSH key not found: $SSH_KEY_PATH"
    echo ""
    echo "Please check SSH_KEY_PATH in $ENV_FILE"
    exit 1
  fi

  # Set defaults
  NETWORK_NAME="${NETWORK_NAME:-shared-services}"
  CONTAINER_NAME="${CONTAINER_NAME:-webgl-spa}"
  IMAGE_NAME="${IMAGE_NAME:-webgl-spa}"
  DOMAIN="${DOMAIN:-folkweather.com}"
  APP_PATH="${APP_PATH:-/spa}"

  log_success "Configuration loaded from $ENV_FILE"
}

# =============================================================================
# PHASE 2: VALIDATE REMOTE SERVER
# =============================================================================

validate_remote() {
  log_step "Phase 2: Validating remote server..."

  # Test SSH connection
  log_info "Testing SSH connection to $REMOTE_HOST..."
  if ! ssh_cmd "echo 'SSH connection successful'" 2>/dev/null; then
    log_error "Cannot connect to $REMOTE_HOST"
    echo ""
    echo "Please ensure:"
    echo "  1. The server is running and accessible"
    echo "  2. Your SSH key is authorized on the server"
    exit 1
  fi
  log_success "SSH connection successful"

  # Check Docker
  log_info "Checking Docker installation..."
  if ! ssh_cmd "docker --version" 2>/dev/null; then
    log_error "Docker is not installed on $REMOTE_HOST"
    exit 1
  fi
  log_success "Docker is installed"

  # Check Docker permissions
  if ! ssh_cmd "docker ps" 2>/dev/null; then
    log_error "User cannot access Docker without sudo"
    echo ""
    echo "Please run on remote server:"
    echo "  sudo usermod -aG docker \$USER"
    echo "Then log out and back in."
    exit 1
  fi
  log_success "Docker permissions OK"

  # Check network exists
  log_info "Checking Docker network $NETWORK_NAME..."
  if ! ssh_cmd "docker network inspect $NETWORK_NAME" &>/dev/null; then
    log_error "Docker network '$NETWORK_NAME' does not exist on remote"
    echo ""
    echo "Make sure the shared-services network exists (created by gateway stack):"
    echo "  docker network create $NETWORK_NAME"
    exit 1
  fi
  log_success "Docker network exists"
}

# =============================================================================
# PHASE 3: BUILD IMAGE
# =============================================================================

build_image() {
  log_step "Phase 3: Building Docker image..."

  cd "$PROJECT_ROOT"

  log_info "Building $IMAGE_NAME:latest (this may take a few minutes)..."
  docker build -f Dockerfile.prod -t "$IMAGE_NAME:latest" .

  log_success "Image built successfully"
}

# =============================================================================
# PHASE 4: TRANSFER IMAGE
# =============================================================================

transfer_image() {
  log_step "Phase 4: Transferring image to remote server..."

  local archive="/tmp/${IMAGE_NAME}-image.tar.gz"

  log_info "Saving image to archive..."
  docker save "$IMAGE_NAME:latest" | gzip > "$archive"

  local size=$(du -h "$archive" | cut -f1)
  log_info "Archive size: $size"

  log_info "Transferring to remote server..."
  scp_cmd "$archive" "$REMOTE_HOST:/tmp/"

  log_info "Loading image on remote server..."
  ssh_cmd "gunzip -c /tmp/${IMAGE_NAME}-image.tar.gz | docker load"

  # Cleanup
  rm -f "$archive"
  ssh_cmd "rm -f /tmp/${IMAGE_NAME}-image.tar.gz"

  log_success "Image transferred"
}

# =============================================================================
# PHASE 5: SETUP REMOTE
# =============================================================================

setup_remote() {
  log_step "Phase 5: Setting up remote directory..."

  # Create deployment directory (needs sudo for /opt/)
  log_info "Creating $REMOTE_DIR..."
  ssh_cmd "sudo mkdir -p $REMOTE_DIR && sudo chown \$(id -u):\$(id -g) $REMOTE_DIR"

  # Copy docker-compose file
  log_info "Copying docker-compose.prod.yml..."
  scp_cmd "$PROJECT_ROOT/docker-compose.prod.yml" "$REMOTE_HOST:$REMOTE_DIR/"

  log_success "Remote directory ready"
}

# =============================================================================
# PHASE 6: START SERVICE
# =============================================================================

start_service() {
  log_step "Phase 6: Starting WebGL SPA..."

  # Stop existing container if running
  log_info "Stopping existing container (if any)..."
  ssh_cmd "docker stop $CONTAINER_NAME 2>/dev/null || true"
  ssh_cmd "docker rm $CONTAINER_NAME 2>/dev/null || true"

  # Start with docker-compose
  log_info "Starting container..."
  ssh_cmd "cd $REMOTE_DIR && docker compose -f docker-compose.prod.yml up -d"

  # Wait for health check
  log_info "Waiting for container to be healthy..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    local health=$(ssh_cmd "docker inspect --format='{{.State.Health.Status}}' $CONTAINER_NAME 2>/dev/null" || echo "unknown")
    if [[ "$health" == "healthy" ]]; then
      log_success "Container is healthy"
      break
    fi
    echo -ne "\r  Waiting... ($health) ${retries}s remaining"
    sleep 2
    retries=$((retries - 2))
  done
  echo ""

  if [[ $retries -le 0 ]]; then
    log_warn "Health check timeout - container may still be starting"
  fi
}

# =============================================================================
# PHASE 7: VERIFY DEPLOYMENT
# =============================================================================

verify_deployment() {
  log_step "Phase 7: Verifying deployment..."

  # Test via gateway
  log_info "Testing endpoint via gateway..."
  if ssh_cmd "curl -s -o /dev/null -w '%{http_code}' http://localhost${APP_PATH}/" | grep -q "200"; then
    log_success "Gateway endpoint responding"
  else
    log_warn "Gateway endpoint not responding yet (gateway-nginx may need a restart)"
  fi

  # Test external endpoint (if domain is configured)
  if [[ -n "${DOMAIN:-}" ]]; then
    log_info "Testing external endpoint..."
    local status=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN$APP_PATH/" 2>/dev/null || echo "000")
    if [[ "$status" == "200" ]]; then
      log_success "External endpoint responding (https://$DOMAIN$APP_PATH/)"
    else
      log_warn "External endpoint returned $status (may need gateway nginx reload)"
    fi
  fi
}

# =============================================================================
# PHASE 8: PRINT SUMMARY
# =============================================================================

print_summary() {
  echo ""
  echo -e "${GREEN}========================================${NC}"
  echo -e "${GREEN}  WebGL SPA Deployed Successfully!${NC}"
  echo -e "${GREEN}========================================${NC}"
  echo ""
  echo "  https://$DOMAIN$APP_PATH/"
  echo ""
  echo "  Container: $CONTAINER_NAME on network $NETWORK_NAME"
  echo ""
  echo "  Useful Commands:"
  echo "    View logs:      ./scripts/deploy.sh --logs"
  echo "    View status:    ./scripts/deploy.sh --status"
  echo "    SSH to server:  ./scripts/deploy.sh --ssh"
  echo "    Update app:     ./scripts/deploy.sh --update"
  echo ""
}

# =============================================================================
# ADDITIONAL COMMANDS
# =============================================================================

show_status() {
  load_config

  echo ""
  log_info "Container status:"
  ssh_cmd "docker ps --filter name=$CONTAINER_NAME --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'" 2>/dev/null || true

  echo ""
  log_info "Health check:"
  local health=$(ssh_cmd "docker inspect --format='{{.State.Health.Status}}' $CONTAINER_NAME 2>/dev/null" || echo "not running")
  echo "  Status: $health"

  echo ""
  log_info "Image info:"
  ssh_cmd "docker images $IMAGE_NAME --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}'" 2>/dev/null || true
  echo ""
}

show_logs() {
  load_config
  ssh_cmd "docker logs -f $CONTAINER_NAME"
}

do_ssh() {
  load_config
  ssh -i "$SSH_KEY_PATH" "$REMOTE_HOST"
}

do_update() {
  load_config
  validate_remote
  build_image
  transfer_image
  setup_remote
  start_service
  verify_deployment
  print_summary
}

do_rebuild() {
  load_config
  validate_remote

  log_step "Phase 3: Building Docker image (no cache)..."
  cd "$PROJECT_ROOT"
  log_info "Building $IMAGE_NAME:latest with --no-cache..."
  docker build --no-cache -f Dockerfile.prod -t "$IMAGE_NAME:latest" .
  log_success "Image built successfully"

  transfer_image
  setup_remote
  start_service
  verify_deployment
  print_summary
}

# =============================================================================
# MAIN
# =============================================================================

main() {
  case "${1:-}" in
    --help|-h)   show_help ;;
    --status)    show_status ;;
    --logs)      show_logs ;;
    --ssh)       do_ssh ;;
    --update)    do_update ;;
    --rebuild)   do_rebuild ;;
    *)
      # Full deployment
      load_config
      validate_remote
      build_image
      transfer_image
      setup_remote
      start_service
      verify_deployment
      print_summary
      ;;
  esac
}

main "$@"
