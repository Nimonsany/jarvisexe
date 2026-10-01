#!/usr/bin/env python3
"""M9 Phase 22 — machine-readable release manifest.

Runs in the release publish job: merges per-platform build-info-*.json written
by the package jobs with checksums/signing facts for every artifact in dist/.
No secrets are included. Usage: release-manifest.py <dist-dir> <git-tag>
"""
import glob
import hashlib
import json
import os
import sys
from datetime import datetime, timezone


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    dist, tag = sys.argv[1], sys.argv[2]
    version = tag[1:] if tag.startswith('v') else tag
    commit = os.environ.get('GITHUB_SHA', 'unknown')

    build_info = {}
    for f in glob.glob(os.path.join(dist, 'build-info-*.json')):
        info = json.load(open(f))
        build_info[info['platform']] = info

    # macOS signing evidence (written by codesign -dv in the macOS job)
    mac_sign = 'unknown'
    sign_txt = os.path.join(dist, 'macos-codesign.txt')
    if os.path.exists(sign_txt):
        txt = open(sign_txt).read()
        if 'Signature=adhoc' in txt or 'adhoc' in txt.lower():
            mac_sign = 'ad-hoc'
        elif 'Developer ID' in txt:
            mac_sign = 'Developer ID'
        elif 'not signed' in txt.lower() or 'code object is not signed' in txt.lower():
            mac_sign = 'unsigned'
        else:
            mac_sign = 'unrecognized(see macos-codesign.txt)'

    artifacts = []
    for path in sorted(glob.glob(os.path.join(dist, '*'))):
        name = os.path.basename(path)
        if name in ('SHA256SUMS.txt', 'release-manifest.json') or name.startswith('build-info-') \
                or name == 'macos-codesign.txt':
            continue
        if name.endswith('.sig'):
            status = 'n/a (updater signature file)'
        elif name.endswith(('.dmg', '.app.tar.gz')):
            status = mac_sign
        else:
            status = 'unsigned'
        entry = {
            'filename': name,
            'size': os.path.getsize(path),
            'sha256': sha256(path),
            'signingStatus': status,
            'notarizationStatus': 'no' if status != 'n/a (updater signature file)' else 'n/a',
        }
        if os.path.exists(path + '.sig'):
            entry['updaterSignatureFile'] = name + '.sig'
        artifacts.append(entry)

    manifest = {
        'product': 'JARVIS',
        'version': version,
        'tag': tag,
        'gitCommit': commit,
        'buildTimestamp': datetime.now(timezone.utc).isoformat(),
        'tauriVersion': next(iter(build_info.values()), {}).get('tauriVersion', 'unknown'),
        'nodeVersion': next(iter(build_info.values()), {}).get('nodeVersion', 'unknown'),
        'rustVersion': next(iter(build_info.values()), {}).get('rustVersion', 'unknown'),
        'platforms': sorted(build_info.keys()),
        'builds': build_info,
        'artifacts': artifacts,
        'checksumsFile': 'SHA256SUMS.txt',
        'updaterMetadata': 'latest.json',
        'signingNote': 'updater artifacts signed (Ed25519); platform installers unsigned — see signingStatus',
    }
    out = os.path.join(dist, 'release-manifest.json')
    json.dump(manifest, open(out, 'w'), indent=2)
    print(f'release-manifest.json: {len(artifacts)} artifacts, platforms={manifest["platforms"]}')


if __name__ == '__main__':
    main()
