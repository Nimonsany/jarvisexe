#!/usr/bin/env python3
"""Per-platform build facts for the release manifest (M9 Phase 22).
Usage: build-info.py <platform> <arch>   (run inside the package job, dist/ present)
"""
import datetime
import json
import os
import re
import subprocess
import sys

platform, arch = sys.argv[1], sys.argv[2]
lock = open('apps/desktop/src-tauri/Cargo.lock').read()
tauri = re.search(r'name = "tauri"\nversion = "([^"]+)"', lock).group(1)
json.dump(
    {
        'platform': platform,
        'arch': arch,
        'tauriVersion': tauri,
        'nodeVersion': subprocess.check_output(['node', '-v'], text=True).strip(),
        'rustVersion': subprocess.check_output(['rustc', '-V'], text=True).strip(),
        'commit': os.environ.get('GITHUB_SHA', 'local'),
        'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    },
    open(f'dist/build-info-{platform}.json', 'w'),
    indent=2,
)
print(f'build-info-{platform}.json written ({platform}/{arch})')
