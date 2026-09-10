#!/usr/bin/env python3
"""Generate and sync Flatpak source manifests for pnpm and NuGet inputs."""

import argparse
import re
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional

from _flatpak_env import ensure_venv, repo_root, run_command
from _flatpak_nuget_hash import (
    collect_nuget_input_files,
    compute_nuget_sources_hash,
    read_stored_hash as read_nuget_stored_hash,
    write_stored_hash as write_nuget_stored_hash,
)
from _flatpak_pnpm_hash import (
    collect_lockfiles,
    compute_sources_hash,
    read_stored_hash as read_sources_stored_hash,
    write_stored_hash as write_sources_stored_hash,
)


DEFAULT_LOCKFILE = "pnpm-lock.yaml"
DEFAULT_PNPM_OUTPUT = "flatpak/generated-sources.json"
DEFAULT_PNPM_HASH_FILE = "flatpak/generated-sources.hash"
DEFAULT_PNPM_STORE_VERSION = "v11"
DEFAULT_NUGET_SEARCH_ROOT = "extensions"
DEFAULT_NUGET_OUTPUT = "flatpak/generated-nuget-sources.json"
DEFAULT_NUGET_HASH_FILE = "flatpak/generated-nuget-sources.hash"
DEFAULT_DOTNET = "9"
DEFAULT_FREEDESKTOP = "25.08"
DEFAULT_DESTDIR = "flatpak-nuget-sources"
DEFAULT_RUNTIME = "linux-x64"


def _block_end(lines: List[str], start: int, indent: int) -> int:
    """Return the first line outside a YAML indentation block."""
    index = start + 1
    while index < len(lines):
        line = lines[index]
        if line.strip():
            line_indent = len(line) - len(line.lstrip(" "))
            if line_indent <= indent:
                break
        index += 1
    return index


def _strip_pnpm_managed_runtimes(project_document: str) -> tuple[str, int]:
    """Remove pnpm runtime protocol entries from the generator-only lockfile.

    pnpm 11 encodes ``devEngines.runtime`` as e.g. ``node@runtime:24.20.0``.
    flatpak-node-generator currently interprets that as a normal npm package
    and constructs an invalid registry URL such as
    ``node/-/node-runtime:24.20.0.tgz``. Flatpak provides Node through the
    org.freedesktop.Sdk.Extension.node24 SDK extension, so runtime artifacts
    must not be part of the generated npm source graph.

    Only the temporary lockfile passed to flatpak-node-generator is changed;
    the repository pnpm-lock.yaml remains byte-for-byte untouched for pnpm's
    own frozen-lockfile validation.
    """
    lines = project_document.splitlines(keepends=True)
    output: List[str] = []
    removed = 0
    index = 0

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" ")) if stripped else -1

        # packages:/snapshots: entries such as either:
        #   node@runtime:24.20.0:
        #   node@runtime:24.20.0: {}
        # Both are pnpm metadata for devEngines.runtime, not npm packages.
        if indent == 2 and "@runtime:" in stripped:
            index = _block_end(lines, index, indent)
            removed += 1
            continue

        # Root importer dependency such as:
        #       node:
        #         specifier: runtime:24.20.0
        #         version: runtime:24.20.0
        if indent == 6 and stripped.endswith(":"):
            end = _block_end(lines, index, indent)
            block = "".join(lines[index:end])
            if re.search(r"(?m)^\s+(?:specifier|version):\s+runtime:", block):
                index = end
                removed += 1
                continue

        output.append(line)
        index += 1

    return "".join(output), removed


def _project_lockfile_for_generator(lockfile: Path) -> Optional[Path]:
    """Extract pnpm's project lockfile document for single-document consumers.

    pnpm 11 writes an environment lockfile document first (package-manager and
    config dependencies) and the real project dependency graph last. The
    upstream Flatpak node generator currently uses PyYAML.safe_load(), so feed
    it a temporary copy of only the final project document. The committed
    pnpm-lock.yaml remains untouched and is still what pnpm itself consumes.
    """
    raw = lockfile.read_text(encoding="utf-8")
    documents = [
        document.lstrip("\r\n")
        for document in re.split(r"(?m)^---\s*$", raw)
        if document.strip()
    ]
    if len(documents) <= 1:
        return None

    project_document = documents[-1]
    if not project_document.startswith("lockfileVersion:"):
        raise ValueError(f"Unexpected final pnpm lockfile document in {lockfile}")
    if "\npackages:" not in project_document:
        raise ValueError(f"Final pnpm lockfile document has no packages section: {lockfile}")

    project_document, removed_runtime_blocks = _strip_pnpm_managed_runtimes(
        project_document
    )
    print(
        "pnpm multi-document lockfile detected; removed "
        f"{removed_runtime_blocks} pnpm-managed runtime block(s) from the "
        "generator-only project document"
    )

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=".flatpak-project-pnpm-lock-",
        suffix=".yaml",
        dir=lockfile.parent,
        delete=False,
    ) as temp:
        temp.write("---\n")
        temp.write(project_document)
        if not project_document.endswith("\n"):
            temp.write("\n")
        temporary_path = Path(temp.name)

    print(
        "using the final project document for flatpak-node-generator: "
        f"{temporary_path.name}"
    )
    return temporary_path


def generate_sources(
    lockfile: Path,
    output: Path,
    recursive: bool,
    lockfiles: Optional[List[Path]] = None,
) -> None:
    info = ensure_venv(install_packages=True)
    root = repo_root()

    temporary_lockfile = _project_lockfile_for_generator(lockfile)
    generator_lockfile = temporary_lockfile or lockfile
    try:
        cmd = [
            str(info.flatpak_node_generator),
            "pnpm",
            str(generator_lockfile),
            "-o",
            str(output),
            "--electron-node-headers",
            "--pnpm-store-version",
            DEFAULT_PNPM_STORE_VERSION,
        ]
        if recursive:
            if lockfiles is None:
                lockfiles = collect_lockfiles(lockfile=lockfile, recursive=True)
            cmd.append("-r")
            for lockfile_path in lockfiles:
                cmd.extend(["-R", str(lockfile_path)])

        run_command(cmd, cwd=root)
    finally:
        if temporary_lockfile is not None:
            temporary_lockfile.unlink(missing_ok=True)


def sync_generated_sources(
    lockfile: Path,
    output: Path,
    hash_file: Path,
    recursive: bool = True,
    force: bool = False,
) -> bool:
    root = repo_root()
    if not lockfile.is_absolute():
        lockfile = root / lockfile
    if not output.is_absolute():
        output = root / output
    if not hash_file.is_absolute():
        hash_file = root / hash_file

    source_hash, lockfiles = compute_sources_hash(
        lockfile=lockfile, recursive=recursive
    )
    stored_hash = read_sources_stored_hash(hash_file)

    if not force and output.exists() and stored_hash == source_hash:
        print("Flatpak generated sources are up to date (hash match).")
        return False

    if force:
        print("Regenerating flatpak sources (forced by --force).")
    elif not output.exists():
        print(f"Regenerating flatpak sources (missing output: {output}).")
    elif stored_hash is None:
        print(f"Regenerating flatpak sources (missing hash file: {hash_file}).")
    else:
        print("Regenerating flatpak sources (lockfile hash changed).")

    generate_sources(
        lockfile=lockfile,
        output=output,
        recursive=recursive,
        lockfiles=lockfiles,
    )
    write_sources_stored_hash(hash_file=hash_file, value=source_hash)
    print(f"Updated Flatpak sources hash: {hash_file}")
    return True


def _resolve_paths(paths: Iterable[Path], root: Path) -> List[Path]:
    resolved: List[Path] = []
    for path in paths:
        resolved.append(path if path.is_absolute() else root / path)
    return resolved


def _discover_nuget_projects(search_root: Path) -> List[Path]:
    projects = [
        path
        for path in collect_nuget_input_files(search_root=search_root)
        if path.suffix.lower() == ".csproj"
    ]
    if not projects:
        raise FileNotFoundError(f"No .csproj files found under: {search_root}")
    return projects


def generate_nuget_sources(
    projects: List[Path],
    output: Path,
    dotnet: str,
    freedesktop: str,
    destdir: str,
    runtime: str,
) -> None:
    info = ensure_venv(install_packages=True)
    root = repo_root()

    cmd = [
        str(info.python_exe),
        str(info.flatpak_dotnet_generator),
        "--dotnet",
        dotnet,
        "--freedesktop",
        freedesktop,
        "--destdir",
        destdir,
        str(output),
        *[str(project) for project in projects],
        "--runtime",
        runtime,
    ]

    run_command(cmd, cwd=root)


def sync_generated_nuget_sources(
    search_root: Path,
    projects: Optional[List[Path]],
    output: Path,
    hash_file: Path,
    dotnet: str,
    freedesktop: str,
    destdir: str,
    runtime: str,
    force: bool = False,
) -> bool:
    root = repo_root()
    if not search_root.is_absolute():
        search_root = root / search_root
    if not output.is_absolute():
        output = root / output
    if not hash_file.is_absolute():
        hash_file = root / hash_file

    if projects:
        projects = _resolve_paths(projects, root)
    else:
        projects = _discover_nuget_projects(search_root)

    for project in projects:
        if not project.exists():
            raise FileNotFoundError(f"NuGet project not found: {project}")

    source_hash, _ = compute_nuget_sources_hash(search_root=search_root)
    stored_hash = read_nuget_stored_hash(hash_file)

    if not force and output.exists() and stored_hash == source_hash:
        print("Flatpak NuGet sources are up to date (hash match).")
        return False

    if force:
        print("Regenerating Flatpak NuGet sources (forced by --force).")
    elif not output.exists():
        print(f"Regenerating Flatpak NuGet sources (missing output: {output}).")
    elif stored_hash is None:
        print(f"Regenerating Flatpak NuGet sources (missing hash file: {hash_file}).")
    else:
        print("Regenerating Flatpak NuGet sources (project hash changed).")

    generate_nuget_sources(
        projects=projects,
        output=output,
        dotnet=dotnet,
        freedesktop=freedesktop,
        destdir=destdir,
        runtime=runtime,
    )
    write_nuget_stored_hash(hash_file=hash_file, value=source_hash)
    print(f"Updated Flatpak NuGet sources hash: {hash_file}")
    return True


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate Flatpak source manifests. "
            "By default this updates both generated-sources.json and "
            "generated-nuget-sources.json."
        )
    )

    parser.add_argument(
        "--only",
        choices=("all", "pnpm", "nuget"),
        default="all",
        help="Select which source types to sync (default: all)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Always regenerate selected source files, even when hashes match",
    )

    nuget_group = parser.add_argument_group("nuget options")
    nuget_group.add_argument(
        "--search-root",
        default=DEFAULT_NUGET_SEARCH_ROOT,
        help="Root directory to scan for NuGet dependency changes (default: extensions)",
    )
    nuget_group.add_argument(
        "--project",
        action="append",
        default=[],
        help=(
            "Project file path (repeat for multiple projects). "
            "If omitted, all .csproj files under --search-root are used"
        ),
    )

    return parser


def main() -> None:
    args = _build_parser().parse_args()

    run_pnpm = args.only in {"all", "pnpm"}
    run_nuget = args.only in {"all", "nuget"}

    if run_pnpm:
        sync_generated_sources(
            lockfile=Path(DEFAULT_LOCKFILE),
            output=Path(DEFAULT_PNPM_OUTPUT),
            hash_file=Path(DEFAULT_PNPM_HASH_FILE),
            recursive=False,
            force=args.force,
        )

    if run_nuget:
        projects = [Path(project) for project in args.project] if args.project else None

        sync_generated_nuget_sources(
            search_root=Path(args.search_root),
            projects=projects,
            output=Path(DEFAULT_NUGET_OUTPUT),
            hash_file=Path(DEFAULT_NUGET_HASH_FILE),
            dotnet=DEFAULT_DOTNET,
            freedesktop=DEFAULT_FREEDESKTOP,
            destdir=DEFAULT_DESTDIR,
            runtime=DEFAULT_RUNTIME,
            force=args.force,
        )


if __name__ == "__main__":
    main()
