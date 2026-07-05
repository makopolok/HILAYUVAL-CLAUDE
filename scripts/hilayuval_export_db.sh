#!/usr/bin/env bash
set -euo pipefail
# hilayuval_export_db.sh
# Placed in repo: HILAYUVAL-CLAUDE/scripts
# Usage:
#  - To download latest Heroku backup and export CSVs:
#      ./hilayuval_export_db.sh --heroku-app your-heroku-app-name
#  - Or if you already have a dump file:
#      ./hilayuval_export_db.sh --dump /path/to/latest.dump
#
# Outputs:
#  - CSVs into HILAYUVAL-CLAUDE/db_exports/<timestamp>/
#  - Run log at HILAYUVAL-CLAUDE/db_exports/logs/hilayuval_export_db_run_<timestamp>.log

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_BASE_DIR="$REPO_ROOT/db_exports"
LOG_DIR="$EXPORT_BASE_DIR/logs"

APP=""
DUMP_PATH=""
PG_CONTAINER_NAME="hilayuval-pg"
PG_CONTAINER_PORT=5433
PG_USER="postgres"
PG_PASS="postgres"
PG_DB_BASE="hilayuval_restore"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
# default to non-destructive: create a timestamped DB for viewing only
PG_DB="${PG_DB_BASE}_${TIMESTAMP}"
OUT_DIR="${EXPORT_BASE_DIR}/${TIMESTAMP}"
# CLEAN_RESTORE=0 means non-destructive (create new timestamped DB); set to 1 to DROP/RECREATE
CLEAN_RESTORE=0

function usage() {
  echo "Usage: $0 (--heroku-app <app-name> | --dump <path-to-dump>) [--open]"
  exit 2
}

if [ $# -eq 0 ]; then usage; fi

OPEN_FOLDER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --heroku-app) APP="$2"; shift 2 ;;
    --dump) DUMP_PATH="$2"; shift 2 ;;
    --open) OPEN_FOLDER=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

mkdir -p "${OUT_DIR}"
mkdir -p "${LOG_DIR}"
RUN_LOG="${LOG_DIR}/hilayuval_export_db_run_${TIMESTAMP}.log"

# Tee everything to run log while also showing on console
exec > >(tee -a "${RUN_LOG}") 2>&1

echo "Run timestamp: ${TIMESTAMP}"
echo "Run log: ${RUN_LOG}"

# Step A: get dump
if [ -n "${APP}" ]; then
  echo "Downloading latest Heroku backup for app: ${APP}"
  # heroku CLI must be installed and logged in, and the app must be accessible
  (cd "${OUT_DIR}" && heroku pg:backups:download --app "${APP}" --output latest.dump)
  DUMP_PATH="${OUT_DIR}/latest.dump"
  echo "Downloaded dump to ${DUMP_PATH}"
fi

if [ -z "${DUMP_PATH}" ] || [ ! -f "${DUMP_PATH}" ]; then
  echo "Error: no dump specified or dump not found: ${DUMP_PATH}"
  exit 1
fi

# Step B: ensure Docker Postgres is running
if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER_NAME}$"; then
  echo "Using existing Docker container ${PG_CONTAINER_NAME}"
else
  if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER_NAME}$"; then
    echo "Starting existing container ${PG_CONTAINER_NAME}"
    docker start "${PG_CONTAINER_NAME}"
  else
    echo "Creating and starting Postgres container ${PG_CONTAINER_NAME} on port ${PG_CONTAINER_PORT}"
    docker run --name "${PG_CONTAINER_NAME}" -e POSTGRES_PASSWORD="${PG_PASS}" -e POSTGRES_DB=postgres -p ${PG_CONTAINER_PORT}:5432 -d postgres:18
    # wait a few seconds for postgres to initialize
    echo "Waiting for Postgres to initialize..."
    sleep 6
  fi
fi

# Step C: ensure database exists (non-destructive by default)
if [ "${CLEAN_RESTORE}" -eq 1 ]; then
  echo "Dropping and recreating database ${PG_DB} for a clean restore..."
  docker exec -u postgres "${PG_CONTAINER_NAME}" psql -U "${PG_USER}" -c "DROP DATABASE IF EXISTS ${PG_DB};" || true
  docker exec -u postgres "${PG_CONTAINER_NAME}" psql -U "${PG_USER}" -c "CREATE DATABASE ${PG_DB};"
else
  echo "Creating timestamped database ${PG_DB} for non-destructive restore..."
  docker exec -u postgres "${PG_CONTAINER_NAME}" psql -U "${PG_USER}" -c "CREATE DATABASE \"${PG_DB}\";"
fi

# Step D: copy dump into container (so container-side restore can be used if needed)
docker cp "${DUMP_PATH}" "${PG_CONTAINER_NAME}:/tmp/latest.dump" || true

# Step E: prefer host-side pg_restore (use host client to avoid format mismatches)
# Ensure pg_restore is available
if command -v pg_restore >/dev/null 2>&1; then
  echo "Restoring dump into local Postgres at localhost:${PG_CONTAINER_PORT} using host pg_restore..."
  if [ "${CLEAN_RESTORE}" -eq 1 ]; then
    PGPASSWORD="${PG_PASS}" pg_restore -h localhost -p ${PG_CONTAINER_PORT} -U "${PG_USER}" -d "${PG_DB}" --no-owner --role="${PG_USER}" --clean "${DUMP_PATH}" || {
      echo "Host pg_restore failed. Will attempt container-side pg_restore."
      docker exec -i "${PG_CONTAINER_NAME}" pg_restore -U "${PG_USER}" -d "${PG_DB}" --no-owner --clean /tmp/latest.dump
    }
  else
    PGPASSWORD="${PG_PASS}" pg_restore -h localhost -p ${PG_CONTAINER_PORT} -U "${PG_USER}" -d "${PG_DB}" --no-owner --role="${PG_USER}" "${DUMP_PATH}" || {
      echo "Host pg_restore failed. Will attempt container-side pg_restore."
      docker exec -i "${PG_CONTAINER_NAME}" pg_restore -U "${PG_USER}" -d "${PG_DB}" --no-owner /tmp/latest.dump
    }
  fi
else
  echo "pg_restore not found on host - attempting container-side restore..."
  if [ "${CLEAN_RESTORE}" -eq 1 ]; then
    docker exec -i "${PG_CONTAINER_NAME}" pg_restore -U "${PG_USER}" -d "${PG_DB}" --no-owner --clean /tmp/latest.dump
  else
    docker exec -i "${PG_CONTAINER_NAME}" pg_restore -U "${PG_USER}" -d "${PG_DB}" --no-owner /tmp/latest.dump
  fi
fi

echo "Restore complete. Exporting tables to CSVs in ${OUT_DIR} ..."

# Step F: export all public schema tables to CSV files
mkdir -p "${OUT_DIR}"
TABLES=$(docker exec -u postgres "${PG_CONTAINER_NAME}" psql -U "${PG_USER}" -d "${PG_DB}" -At -c "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public';")
if [ -z "${TABLES}" ]; then
  echo "No public tables found. Exiting."
  exit 0
fi

for tbl in ${TABLES}; do
  echo "Exporting table: ${tbl}"
  # Use psql \copy from host (uses libpq) for better permission handling
  PGPASSWORD="${PG_PASS}" psql -h localhost -p ${PG_CONTAINER_PORT} -U "${PG_USER}" -d "${PG_DB}" -c "\copy \"${tbl}\" to '${OUT_DIR}/${tbl}.csv' csv header"
done

echo "All tables exported to ${OUT_DIR}."

if [ "${OPEN_FOLDER}" -eq 1 ]; then
  open "${OUT_DIR}"
fi

echo "Run completed. CSVs are ready. Run log: ${RUN_LOG}"
