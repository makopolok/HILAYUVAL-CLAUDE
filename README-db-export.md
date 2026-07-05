HILAYUVAL DB Export & Local View Tool

This folder contains a script to download/restore a Heroku Postgres dump into a local Docker Postgres container and export all tables as CSVs for easy viewing in Excel/TablePlus/DBeaver.

Location: scripts/hilayuval_export_db.sh

Prerequisites
- Docker Desktop installed and running
- Homebrew + libpq (for host-side pg_restore) recommended: brew install libpq
- (Optional) Heroku CLI for direct download: heroku auth:login

Quick usage
1. Make executable (once):
   chmod +x scripts/hilayuval_export_db.sh

2a. Use an existing dump file (local):
   scripts/hilayuval_export_db.sh --dump /path/to/latest.dump --open

2b. Download latest Heroku backup and restore locally:
   scripts/hilayuval_export_db.sh --heroku-app YOUR-HEROKU-APP --open

What it does
- Starts (or reuses) a Docker Postgres container named hilayuval-pg on localhost:5433
- Restores the dump into a timestamped local DB (hilayuval_restore_YYYYMMDD_HHMMSS) by default
- Exports all public-schema tables to CSV files in db_exports/<timestamp>/
- Writes a run log to db_exports/logs/hilayuval_export_db_run_<timestamp>.log

Safety & notes
- This script performs local operations only and does NOT modify the production Heroku database.
- By default it is non-destructive and creates a new timestamped DB per run. To force a clean destructive restore, edit the script and set CLEAN_RESTORE=1.

GUI Connection
- Use TablePlus/DBeaver to connect to the running container:
  Host: localhost
  Port: 5433
  User: postgres
  Password: postgres
  Database: hilayuval_restore_YYYYMMDD_HHMMSS (the timestamped DB created by the script)

Housekeeping
- Remove old exports and databases when not needed:
  docker exec -it hilayuval-pg psql -U postgres -c "DROP DATABASE IF EXISTS hilayuval_restore_20260702_103000;"
  rm -rf ~/HILAYUVAL-CLAUDE/db_exports/20260702_103000

If you want the script to be destructive by default (drop & recreate), set CLEAN_RESTORE=1 in the script.