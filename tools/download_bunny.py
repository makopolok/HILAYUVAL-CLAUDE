#!/usr/bin/env python3
"""
Download all files from a Bunny Storage zone preserving folder structure.

Requirements:
  - Python 3.8+
  - pip install requests tqdm

Usage:
  export BUNNY_ACCESS_KEY="your_key_here"
  python tools/download_bunny.py --zone hilayuval2 --out ./bunny-download --parallel 4

Options:
  --zone       Bunny storage zone name (required)
  --out        Output directory (default ./bunny-download)
  --parallel   Number of parallel downloads (default 4)
  --force      Redownload files even if present
  --limit      Optional limit to number of files to download (useful for testing)

Behavior:
  - Preserves directory structure
  - Resumes partial downloads using HTTP Range
  - Robust XML parsing of Bunny listing
  - Safe to re-run
"""

import os
import sys
import argparse
import requests
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote
from tqdm import tqdm

BUNNY_API_BASE = "https://storage.bunnycdn.com"


def list_files(zone, access_key):
    """List all files in a zone, following pagination if present.

    Bunny may return a paginated XML listing. This function follows common
    pagination markers (NextMarker, ContinuationToken, Marker) until all keys
    are collected.
    """
    keys = []
    headers = {"AccessKey": access_key}
    marker = None
    while True:
        url = f"{BUNNY_API_BASE}/{zone}/"
        params = {}
        if marker:
            # Bunny may accept a marker query param; include it if present
            params['marker'] = marker
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
        page_keys = [elem.text for elem in root.findall('.//File/Key') if elem is not None and elem.text]
        keys.extend(page_keys)

        # Try several common pagination tokens returned by XML
        next_marker = None
        # Common tags to check: NextMarker, ContinuationToken, NextContinuationToken, Marker, IsTruncated
        nm = root.find('.//NextMarker')
        if nm is not None and nm.text:
            next_marker = nm.text
        if not next_marker:
            ct = root.find('.//ContinuationToken') or root.find('.//NextContinuationToken')
            if ct is not None and ct.text:
                next_marker = ct.text
        if not next_marker:
            m = root.find('.//Marker')
            if m is not None and m.text:
                next_marker = m.text

        # If IsTruncated exists and is true but no marker provided, stop to avoid infinite loop
        is_truncated = False
        it = root.find('.//IsTruncated')
        if it is not None and (it.text or '').lower() in ('true', '1'):
            is_truncated = True

        if next_marker:
            marker = next_marker
            continue
        # No next marker found; stop
        break
    return keys


def download_file(zone, key, access_key, outdir, session, force=False):
    local_path = os.path.join(outdir, key)
    os.makedirs(os.path.dirname(local_path), exist_ok=True)

    if os.path.exists(local_path) and not force:
        if os.path.getsize(local_path) > 0:
            return {"key": key, "status": "skipped", "path": local_path}

    encoded_key = quote(key, safe="/")
    url = f"{BUNNY_API_BASE}/{zone}/{encoded_key}"
    headers = {"AccessKey": access_key}

    mode = "ab"
    resume_pos = 0
    if os.path.exists(local_path):
        resume_pos = os.path.getsize(local_path)

    try:
        if resume_pos > 0:
            headers["Range"] = f"bytes={resume_pos}-"
        with session.get(url, headers=headers, stream=True, timeout=60) as r:
            if r.status_code in (200, 206):
                with open(local_path, mode) as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
                return {"key": key, "status": "downloaded", "path": local_path}
            else:
                return {"key": key, "status": "error", "http_status": r.status_code, "text": r.text}
    except Exception as e:
        return {"key": key, "status": "error", "error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Download all files from a Bunny Storage zone.")
    parser.add_argument("--zone", required=True, help="Bunny storage zone name (e.g., hilayuval2)")
    parser.add_argument("--out", default="./bunny-download", help="Output directory")
    parser.add_argument("--parallel", type=int, default=4, help="Parallel downloads")
    parser.add_argument("--force", action="store_true", help="Force re-download even if file exists")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of files to download (0 = all)")
    args = parser.parse_args()

    access_key = os.getenv("BUNNY_ACCESS_KEY")
    if not access_key:
        print("ERROR: set BUNNY_ACCESS_KEY environment variable", file=sys.stderr)
        sys.exit(2)

    print(f"Listing files in zone: {args.zone} ...")
    keys = list_files(args.zone, access_key)
    if args.limit and args.limit > 0:
        keys = keys[:args.limit]
    print(f"Found {len(keys)} files")

    session = requests.Session()
    results = []
    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as ex:
        futures = [ex.submit(download_file, args.zone, key, access_key, args.out, session, args.force) for key in keys]

        for f in tqdm(as_completed(futures), total=len(futures), desc="Downloading", unit="file"):
            try:
                r = f.result()
                results.append(r)
            except Exception as e:
                results.append({"status": "error", "error": str(e)})

    downloaded = [r for r in results if r.get("status") == "downloaded"]
    skipped = [r for r in results if r.get("status") == "skipped"]
    errors = [r for r in results if r.get("status") == "error"]
    print(f"Downloaded: {len(downloaded)}, Skipped: {len(skipped)}, Errors: {len(errors)}")
    if errors:
        print("Errors (first 10):")
        for e in errors[:10]:
            print(e)


if __name__ == "__main__":
    main()
