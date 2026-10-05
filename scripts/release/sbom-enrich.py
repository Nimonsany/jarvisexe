#!/usr/bin/env python3
"""Enrich an npm-generated SPDX SBOM with what `npm sbom --omit=dev` misses.

APPROXIMATION (stated honestly): the Rust crates added below are the packages in
apps/desktop/src-tauri/Cargo.lock, i.e. the Rust-side dependencies of the desktop
bundle. They are not npm packages and their transitive npm equivalents are not
modelled; every crate is attached to the @jarvis/desktop package entry with a
DEPENDS_ON relationship, which is the closest truthful SPDX statement for
"these crates ship inside the desktop app".

Adds:
  1. Direct production `dependencies` of the root package.json and of every
     workspace package.json (root `workspaces` globs) that are missing from the
     SBOM (react/react-dom were missing). devDependencies/optionalDependencies
     are never added.
  2. Every unique crate from Cargo.lock (460), each with a DEPENDS_ON edge from
     the desktop app package.

Preserves all existing packages, relationships and documentDescribes.
Usage: python3 scripts/release/sbom-enrich.py [path/to/sbom.spdx.json]
(defaults to sbom.spdx.json in the current directory; edits in place).
"""
import glob
import json
import os
import re
import sys

SBOM_PATH = sys.argv[1] if len(sys.argv) > 1 else "sbom.spdx.json"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

NOASSERT = "NOASSERTION"


def npm_spdxid(name, version, taken):
    """Mirror npm's own SPDXID shape: '@tauri-apps/api' -> 'tauri-apps.api'."""
    base = re.sub(r"[^A-Za-z0-9.-]", "-", name.replace("@", "").replace("/", "."))
    sid = f"SPDXRef-Package-{base}-{version}"
    n = 1
    while sid in taken:
        n += 1
        sid = f"SPDXRef-Package-{base}-{version}-{n}"
    return sid


def crate_spdxid(name, version, taken):
    base = re.sub(r"[^A-Za-z0-9.-]", "-", name)
    sid = f"SPDXRef-Package-crate-{base}-{version}"
    n = 1
    while sid in taken:
        n += 1
        sid = f"SPDXRef-Package-crate-{base}-{version}-{n}"
    return sid


def npm_package(name, version, sid):
    return {
        "name": name,
        "SPDXID": sid,
        "versionInfo": version,
        "downloadLocation": NOASSERT,
        "filesAnalyzed": False,
        "licenseDeclared": NOASSERT,
        "licenseConcluded": NOASSERT,
        "packageFileName": f"node_modules/{name}",
        "primaryPackagePurpose": "LIBRARY",
    }


def crate_package(name, version, sid):
    return {
        "name": name,
        "SPDXID": sid,
        "versionInfo": version,
        "downloadLocation": NOASSERT,
        "filesAnalyzed": False,
        "licenseDeclared": NOASSERT,
        "licenseConcluded": NOASSERT,
        "primaryPackagePurpose": "LIBRARY",
    }


def workspace_package_jsons():
    """Root package.json plus every package.json matched by the workspaces globs."""
    paths = [os.path.join(ROOT, "package.json")]
    with open(os.path.join(ROOT, "package.json")) as f:
        for pattern in json.load(f).get("workspaces", []) or []:
            paths.extend(glob.glob(os.path.join(ROOT, pattern, "package.json")))
    out = []
    for p in sorted(paths):
        if os.path.isfile(p):
            out.append(p)
    return out


def lock_version(name, fallback_range):
    """Resolve a dep range to the exact version npm installed (package-lock.json).

    Falls back to the raw range from package.json when the lock has no entry —
    versionInfo then carries the range, which is still better than omitting the
    package entirely."""
    lock_path = os.path.join(ROOT, "package-lock.json")
    try:
        with open(lock_path) as f:
            entry = json.load(f).get("packages", {}).get(f"node_modules/{name}")
        if entry and entry.get("version"):
            return entry["version"]
    except (OSError, ValueError):
        pass
    return fallback_range


def parse_cargo_lock(path):
    """Minimal [[package]] / name / version parser (Cargo.lock is TOML, but a
    line scan is enough and keeps this stdlib-only with no tomllib dependency)."""
    crates, name, version = [], None, None
    with open(path) as f:
        for line in f:
            s = line.strip()
            if s == "[[package]]":
                if name and version:
                    crates.append((name, version))
                name = version = None
            elif s.startswith("name ="):
                name = s.split("=", 1)[1].strip().strip('"')
            elif s.startswith("version ="):
                version = s.split("=", 1)[1].strip().strip('"')
    if name and version:
        crates.append((name, version))
    return crates


def main():
    with open(SBOM_PATH) as f:
        doc = json.load(f)

    packages = doc.setdefault("packages", [])
    relationships = doc.setdefault("relationships", [])
    taken = {p.get("SPDXID") for p in packages}
    present = {(p.get("name"), p.get("versionInfo")) for p in packages}
    edges = {
        (r.get("spdxElementId"), r.get("relatedSpdxElement"), r.get("relationshipType"))
        for r in relationships
    }
    added_npm, added_crates = [], []

    # 1) workspace production deps missing from the SBOM
    for pj in workspace_package_jsons():
        with open(pj) as f:
            meta = json.load(f)
        for dep, rng in (meta.get("dependencies") or {}).items():
            version = lock_version(dep, rng)
            if (dep, version) in present:
                continue
            sid = npm_spdxid(dep, version, taken)
            taken.add(sid)
            present.add((dep, version))
            packages.append(npm_package(dep, version, sid))
            added_npm.append(f"{dep}@{version}")

    # 2) Rust crates of the desktop bundle
    desktop = next(
        (p for p in packages if p.get("name") == "@jarvis/desktop"),
        next((p for p in packages if p.get("name") == "jarvis-orchestrator"), None),
    )
    owner = desktop["SPDXID"] if desktop else None
    cargo_lock = os.path.join(ROOT, "apps", "desktop", "src-tauri", "Cargo.lock")
    for name, version in parse_cargo_lock(cargo_lock):
        if (name, version) in present:
            continue
        sid = crate_spdxid(name, version, taken)
        taken.add(sid)
        present.add((name, version))
        packages.append(crate_package(name, version, sid))
        added_crates.append(f"{name}@{version}")
        if owner:
            edge = (owner, sid, "DEPENDS_ON")
            if edge not in edges:
                edges.add(edge)
                relationships.append(
                    {
                        "spdxElementId": owner,
                        "relatedSpdxElement": sid,
                        "relationshipType": "DEPENDS_ON",
                    }
                )

    with open(SBOM_PATH, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    print(f"sbom-enrich: +{len(added_npm)} npm deps ({', '.join(added_npm) or 'none'})")
    print(f"sbom-enrich: +{len(added_crates)} crates -> {len(packages)} packages total")


if __name__ == "__main__":
    main()
