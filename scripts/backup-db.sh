#!/usr/bin/env bash
# 每周数据库备份，由宿主机 cron 调用（n8n 容器为 Alpine，未安装 pg_dump）。
# 产物：<仓库>/backups/cinescope-YYYY-MM-DD.sql.gz，保留 8 周。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/backups}"
mkdir -p "$DEST"

sudo -n docker exec cinescope-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | gzip > "$DEST/cinescope-$(date +%F).sql.gz"

find "$DEST" -name 'cinescope-*.sql.gz' -mtime +56 -delete

ls -lh "$DEST" | tail -n 5
