#!/usr/bin/env python3
"""M9 Phase 26 — artifact inspection: packaged artifacts must NOT contain
.env files, git metadata, browser profiles/cookies, task logs, private keys,
test credentials or user files.

Usage: inspect-artifact.py FILE [FILE...]
Exits 1 on any hit. Byte-scan is always run; container listing is best-effort
(deb via dpkg-deb, dmg via hdiutil on macOS, else skipped).
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

# real private-key PEM blocks (not regex-source text: requires base64 body + END line)
PEM = re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n[A-Za-z0-9+/=\s]{64,}-----END [A-Z ]*PRIVATE KEY-----')
# raw credentials that never belong in artifacts (all compiled: rx.search needs re.Pattern)
BYTES = [
    ('RSA/OPENSSH private key block', PEM),
    ('possible AWS access key id', re.compile(rb'AKIA[0-9A-Z]{16}')),
    ('possible GitHub token', re.compile(rb'ghp_[A-Za-z0-9]{36}')),
    ('dotenv secret assignment', re.compile(rb'(?m)^(?:OPENAI|ANTHROPIC|GITHUB_TOKEN|TAURI_SIGNING_PRIVATE_KEY)_KEY\s*=\s*\S')),
]

NAME_BAD = re.compile(
    r'(^|/)\.env(\.|$)|(^|/)\.git/|(^|/)Cookies$|browser-profile|(^|/)auth-token$|'
    r'(^|/)runtime/logs|Local Storage/leveldb|(^|/)updater\.key|(^|/)\.DS_Store$|'
    r'(^|/)task.*\.log$', re.I)


def scan_bytes(path: str) -> list[str]:
    hits = []
    with open(path, 'rb') as f:
        data = f.read()
    for label, rx in BYTES:
        m = rx.search(data)
        if m:
            hits.append(f'{path}: {label} at byte {m.start()}')
    return hits


def check_names(path: str, names: list[str]) -> list[str]:
    return [f'{path}: banned member {n!r}' for n in names if NAME_BAD.search(n)]


def list_deb(path: str) -> list[str]:
    if not shutil.which('dpkg-deb'):
        return []
    out = subprocess.run(['dpkg-deb', '-c', path], capture_output=True, text=True)
    names = [ln.split()[-1] for ln in out.stdout.splitlines() if ln.strip()]
    return check_names(path, names)


def list_dmg(path: str) -> list[str]:
    if sys.platform != 'darwin' or not shutil.which('hdiutil'):
        return []
    hits, mount = [], tempfile.mkdtemp(prefix='inspect-')
    attach = subprocess.run(['hdiutil', 'attach', path, '-nobrowse', '-readonly', '-mountpoint', mount],
                            capture_output=True, text=True)
    if attach.returncode != 0:
        return [f'{path}: hdiutil attach failed: {attach.stderr.strip()[:200]}']
    try:
        for root, _dirs, files in os.walk(mount):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, mount)
                if NAME_BAD.search(rel):
                    hits.append(f'{path}: banned member {rel!r}')
                if os.path.getsize(full) < 4 << 20 and not full.endswith(('.png', '.icns', '.ttf', '.otf')):
                    with open(full, 'rb') as f:
                        data = f.read()
                    for label, rx in BYTES:
                        m = rx.search(data)
                        if m:
                            hits.append(f'{path}: {label} in {rel} at byte {m.start()}')
    finally:
        subprocess.run(['hdiutil', 'detach', mount, '-quiet'], capture_output=True)
        os.rmdir(mount)
    return hits


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('usage: inspect-artifact.py FILE...')
    hits: list[str] = []
    for path in sys.argv[1:]:
        if not os.path.isfile(path):
            sys.exit(f'missing artifact: {path}')
        hits += scan_bytes(path)
        if path.endswith('.deb'):
            hits += list_deb(path)
        elif path.endswith('.dmg'):
            hits += list_dmg(path)
        # AppImage/NSIS: byte-scan only (no safe listing tooling cross-platform)
    if hits:
        print('ARTIFACT INSPECTION FAILED:')
        print('\n'.join(hits))
        sys.exit(1)
    print(f'artifact inspection clean: {", ".join(os.path.basename(p) for p in sys.argv[1:])}')


if __name__ == '__main__':
    main()
