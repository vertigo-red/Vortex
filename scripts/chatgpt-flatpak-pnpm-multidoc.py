#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "flatpak/scripts/flatpak_sources.py"
text = path.read_text(encoding="utf-8")

old_import = "import argparse\nfrom pathlib import Path\n"
new_import = "import argparse\nimport re\nimport tempfile\nfrom pathlib import Path\n"
if text.count(old_import) != 1:
    raise SystemExit("flatpak_sources.py import block did not match")
text = text.replace(old_import, new_import, 1)

old_function = '''def generate_sources(
    lockfile: Path,
    output: Path,
    recursive: bool,
    lockfiles: Optional[List[Path]] = None,
) -> None:
    info = ensure_venv(install_packages=True)

    root = repo_root()

    cmd = [
        str(info.flatpak_node_generator),
        "pnpm",
        str(lockfile),
        "-o",
        str(output),
        "--electron-node-headers",
    ]
    if recursive:
        if lockfiles is None:
            lockfiles = collect_lockfiles(lockfile=lockfile, recursive=True)
        cmd.append("-r")
        for lockfile_path in lockfiles:
            cmd.extend(["-R", str(lockfile_path)])

    run_command(cmd, cwd=root)
'''

new_function = '''def _block_end(lines: List[str], start: int, indent: int) -> int:
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

        # packages:/snapshots: entries such as:
        #   node@runtime:24.20.0:
        if indent == 2 and "@runtime:" in stripped and stripped.endswith(":"):
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
            if re.search(r"(?m)^\\s+(?:specifier|version):\\s+runtime:", block):
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
        document.lstrip("\\r\\n")
        for document in re.split(r"(?m)^---\\s*$", raw)
        if document.strip()
    ]
    if len(documents) <= 1:
        return None

    project_document = documents[-1]
    if not project_document.startswith("lockfileVersion:"):
        raise ValueError(f"Unexpected final pnpm lockfile document in {lockfile}")
    if "\\npackages:" not in project_document:
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
        temp.write("---\\n")
        temp.write(project_document)
        if not project_document.endswith("\\n"):
            temp.write("\\n")
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
'''

if text.count(old_function) != 1:
    raise SystemExit("migrated generate_sources function did not match")
text = text.replace(old_function, new_function, 1)
path.write_text(text, encoding="utf-8")
