#!/bin/bash
set -e

git pull
GIT_SHA=$(git rev-parse HEAD) docker compose -f compose.yaml -f compose.prod.yaml build
docker compose -f compose.yaml -f compose.prod.yaml up -d
