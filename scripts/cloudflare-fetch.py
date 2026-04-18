#!/usr/bin/env python3
"""Fetch a URL with TLS impersonation to bypass Cloudflare bot challenge.

Usage: cloudflare-fetch.py <url>
Prints response body to stdout. Exit code 0 on HTTP 200, 1 on any other outcome.

Rumble (as of 2026-04) returns 403 with a "Just a moment..." JS challenge
for urllib / requests / plain curl / yt-dlp's default handlers. curl_cffi
with TLS fingerprint impersonation gets through — but only for certain
Chrome versions. `chrome136` (the newest at time of writing) is flagged;
`chrome131` through `chrome119` pass. Ordering below reflects that.
If Cloudflare rotates and `chrome131` stops working, try adding newer
or older targets and pick whichever yields a 200 with body > 100KB.
"""
import sys
from curl_cffi import requests

TARGETS = ["chrome131", "chrome124", "chrome119", "chrome123", "chrome110"]

def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: cloudflare-fetch.py <url>\n")
        sys.exit(2)
    url = sys.argv[1]
    last_err = None
    for target in TARGETS:
        try:
            r = requests.get(url, impersonate=target, timeout=15)
            if r.status_code == 200 and len(r.text) > 1000:
                sys.stdout.write(r.text)
                return 0
            last_err = f"{target}: status={r.status_code} len={len(r.text)}"
        except Exception as e:
            last_err = f"{target}: {e}"
    sys.stderr.write(f"all targets failed; last: {last_err}\n")
    return 1

if __name__ == "__main__":
    sys.exit(main())
