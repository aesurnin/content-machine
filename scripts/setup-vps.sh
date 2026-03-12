#!/usr/bin/env bash
# One-time VPS setup: install Docker and Docker Compose
# Run as root or with sudo: curl -fsSL https://raw.githubusercontent.com/.../setup-vps.sh | bash

set -e

echo "Installing Docker..."
curl -fsSL https://get.docker.com | sh

echo "Adding current user to docker group..."
if [ -n "$SUDO_USER" ]; then
  usermod -aG docker "$SUDO_USER"
  echo "User $SUDO_USER added to docker group. Log out and back in for it to take effect."
else
  usermod -aG docker "$(whoami)"
  echo "You were added to docker group. Log out and back in for it to take effect."
fi

echo "Docker installed. Version:"
docker --version
docker compose version 2>/dev/null || docker-compose --version
