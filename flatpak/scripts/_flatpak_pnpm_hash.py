#!/usr/bin/env python3
"""Hash helpers for Flatpak pnpm generated-source synchronization."""

import hashlib
from pathlib import Path
from typing import List, Optional, Tuple

from _flatpak_env import FLATPAK_NODE_GENERATOR_GIT_COMMIT, repo_root


def collect_lockfiles(lockfile: Path, recursive: bool) -> List[Path]:
    root = repo_root()
    if not lockfile.is_absolute():
        lockfile = root / lockfile

    if recursive:
        raise ValueError(
            "pnpm uses the single root pnpm-lock.yaml for this workspace; "
            "recursive lockfile mode is not supported"
        )
    if not lockfile.exists():
        raise FileNotFoundError(f"Lockfile not found: {lockfile}")
    return [lockfile]


def compute_sources_hash(lockfile: Path, recursive: bool) -> Tuple[str, List[Path]]:
    root = repo_root()
    lockfiles = collect_lockfiles(lockfile=lockfile, recursive=recursive)

    digest = hashlib.sha256()
    digest.update(b"flatpak-generated-pnpm-sources-hash-v2\n")
    digest.update(
        f"generator:{FLATPAK_NODE_GENERATOR_GIT_COMMIT}\n".encode("utf-8")
    )

    for path in lockfiles:
        relative = path.relative_to(root).as_posix()
        contents = path.read_bytes()
        digest.update(f"path:{relative}\n".encode("utf-8"))
        digest.update(f"size:{len(contents)}\n".encode("utf-8"))
        digest.update(contents)
        digest.update(b"\n")

    return digest.hexdigest(), lockfiles


def read_stored_hash(hash_file: Path) -> Optional[str]:
    if not hash_file.exists():
        return None
    value = hash_file.read_text(encoding="utf-8").strip()
    return value or None


def write_stored_hash(hash_file: Path, value: str) -> None:
    hash_file.parent.mkdir(parents=True, exist_ok=True)
    hash_file.write_text(f"{value}\n", encoding="utf-8")
