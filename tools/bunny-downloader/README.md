Bunny Storage Downloader (Docker)

This directory provides a small Docker image that runs the download_bunny.py tool.

Build:
  docker build -t bunny-downloader:latest .

Run (example):
  docker run --rm -e BUNNY_ACCESS_KEY="${BUNNY_ACCESS_KEY}" \
    -v $(pwd)/bunny-download:/data bunny-downloader:latest \
    --zone hilayuval2 --out /data --parallel 4

Notes:
- The script expects the environment variable BUNNY_ACCESS_KEY to be set.
- Mount a host folder as the output directory (-v hostdir:/data) so downloads are persisted.
