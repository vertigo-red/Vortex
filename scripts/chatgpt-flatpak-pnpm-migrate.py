#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


env = ROOT / "flatpak/scripts/_flatpak_env.py"
replace_once(
    env,
    'FLATPAK_NODE_GENERATOR_GIT_COMMIT = "216a52efa4fcaaf6612147ffe53d9b70c97addfc"',
    'FLATPAK_NODE_GENERATOR_GIT_COMMIT = "1fc32195e3e60fe5c97f0af646dec7a99df5962b"',
    "flatpak-node-generator pin",
)

old_hash = ROOT / "flatpak/scripts/_flatpak_yarn_hash.py"
new_hash = ROOT / "flatpak/scripts/_flatpak_pnpm_hash.py"
if not old_hash.exists():
    raise SystemExit("expected legacy _flatpak_yarn_hash.py")
new_hash.write_text(
    '''#!/usr/bin/env python3
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
    digest.update(b"flatpak-generated-pnpm-sources-hash-v2\\n")
    digest.update(
        f"generator:{FLATPAK_NODE_GENERATOR_GIT_COMMIT}\\n".encode("utf-8")
    )

    for path in lockfiles:
        relative = path.relative_to(root).as_posix()
        contents = path.read_bytes()
        digest.update(f"path:{relative}\\n".encode("utf-8"))
        digest.update(f"size:{len(contents)}\\n".encode("utf-8"))
        digest.update(contents)
        digest.update(b"\\n")

    return digest.hexdigest(), lockfiles


def read_stored_hash(hash_file: Path) -> Optional[str]:
    if not hash_file.exists():
        return None
    value = hash_file.read_text(encoding="utf-8").strip()
    return value or None


def write_stored_hash(hash_file: Path, value: str) -> None:
    hash_file.parent.mkdir(parents=True, exist_ok=True)
    hash_file.write_text(f"{value}\\n", encoding="utf-8")
''',
    encoding="utf-8",
)
old_hash.unlink()

sources = ROOT / "flatpak/scripts/flatpak_sources.py"
text = sources.read_text(encoding="utf-8")
replacements = [
    ('Generate and sync Flatpak source manifests for yarn and NuGet inputs.', 'Generate and sync Flatpak source manifests for pnpm and NuGet inputs.'),
    ('from _flatpak_yarn_hash import (', 'from _flatpak_pnpm_hash import ('),
    ('DEFAULT_LOCKFILE = "yarn.lock"', 'DEFAULT_LOCKFILE = "pnpm-lock.yaml"'),
    ('DEFAULT_YARN_OUTPUT', 'DEFAULT_PNPM_OUTPUT'),
    ('DEFAULT_YARN_HASH_FILE', 'DEFAULT_PNPM_HASH_FILE'),
    ('        "yarn",\n', '        "pnpm",\n'),
    ('        str(output),\n    ]', '        str(output),\n        "--electron-node-headers",\n    ]'),
    ('choices=("all", "yarn", "nuget")', 'choices=("all", "pnpm", "nuget")'),
    ('run_yarn = args.only in {"all", "yarn"}', 'run_pnpm = args.only in {"all", "pnpm"}'),
    ('if run_yarn:', 'if run_pnpm:'),
    ('output=Path(DEFAULT_YARN_OUTPUT)', 'output=Path(DEFAULT_PNPM_OUTPUT)'),
    ('hash_file=Path(DEFAULT_YARN_HASH_FILE)', 'hash_file=Path(DEFAULT_PNPM_HASH_FILE)'),
    ('recursive=True,\n            force=args.force,', 'recursive=False,\n            force=args.force,'),
]
for old, new in replacements:
    if old not in text:
        raise SystemExit(f"flatpak_sources.py missing expected text: {old!r}")
    text = text.replace(old, new)
sources.write_text(text, encoding="utf-8")

workflow = ROOT / "flatpak/scripts/_flatpak_workflow.py"
replace_once(workflow, 'lockfile=root / "yarn.lock"', 'lockfile=root / "pnpm-lock.yaml"', "workflow lockfile")
replace_once(workflow, 'recursive=True,', 'recursive=False,', "workflow recursive mode")

manifest = ROOT / "flatpak/com.nexusmods.vortex.yaml"
text = manifest.read_text(encoding="utf-8")
old_env = '''  prepend-path: /usr/lib/sdk/node24/bin:/usr/lib/sdk/dotnet9/bin
  append-ld-library-path: /usr/lib/sdk/dotnet9/lib
  env:
    # Electron install behavior (global): prevent Electron downloads because BaseApp provides it.
    # Ref: https://github.com/electron/electron/blob/main/docs/api/environment-variables.md
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1"

    # Node/Yarn offline cache locations for reproducible builds.
    # Flatpak builds run offline by default; these paths are inside the build sandbox.
    # Ref: https://docs.flatpak.org/en/latest/electron.html#the-application-module
    npm_config_cache: /run/build/vortex/flatpak-node/npm-cache
    npm_config_nodedir: /usr/lib/sdk/node24
    npm_config_offline: "true"
    XDG_CACHE_HOME: /run/build/vortex/flatpak-node/cache
    YARN_CACHE_FOLDER: /run/build/vortex/flatpak-node/yarn-cache
    YARN_IGNORE_ENGINES: "1"
    YARN_OFFLINE_MIRROR: /run/build/vortex/flatpak-node/yarn-mirror
    YARN_OFFLINE_MIRROR_PRUNING: "false"
'''
new_env = '''  prepend-path: /run/build/vortex/.flatpak-bin:/usr/lib/sdk/node24/bin:/usr/lib/sdk/dotnet9/bin
  append-ld-library-path: /usr/lib/sdk/dotnet9/lib
  env:
    # Flatpak builds run offline. flatpak-node-generator populates the pnpm
    # store and Electron/node-gyp caches from generated-sources.json.
    npm_config_cache: /run/build/vortex/flatpak-node/npm-cache
    npm_config_offline: "true"
    XDG_CACHE_HOME: /run/build/vortex/flatpak-node/cache
'''
if old_env not in text:
    raise SystemExit("manifest environment block did not match")
text = text.replace(old_env, new_env, 1)

old_build = '''      # Configure Yarn for Flatpak caches, then install dependencies.
      - cp flatpak/yarnrc .yarnrc
      - |
        cat > NuGet.Config <<'EOF'
        <?xml version="1.0" encoding="utf-8"?>
        <configuration>
          <packageSources>
            <clear />
            <add key="offline" value="flatpak-nuget-sources" />
          </packageSources>
        </configuration>
        EOF
      - yarn install --non-interactive --check-files --frozen-lockfile
      # Build the app following the standard workflow from CONTRIBUTING.md.
      - yarn run build

      # Prepare app/ directory for packaging
      - yarn run _install_app
      - yarn run subprojects_app
      - yarn run _assets_app
      - yarn run build_dist

      # Build Electron distribution with electron-builder (dir target)
      # This creates dist/linux-unpacked/ with the electron binary bundled
      - yarn electron-builder --config electron-builder-config.json --publish never --linux dir
'''
new_build = '''      # Bootstrap the exact pnpm version pinned by package.json. The tarball is
      # fetched by flatpak-builder before the network-isolated build starts.
      - |
        mkdir -p .flatpak-bin
        cat > .flatpak-bin/pnpm <<'EOF'
        #!/bin/sh
        exec node /run/build/vortex/flatpak-pnpm/package/bin/pnpm.mjs "$@"
        EOF
        chmod +x .flatpak-bin/pnpm
        test "$(pnpm --version)" = "11.10.0"
      - |
        cat > NuGet.Config <<'EOF'
        <?xml version="1.0" encoding="utf-8"?>
        <configuration>
          <packageSources>
            <clear />
            <add key="offline" value="flatpak-nuget-sources" />
          </packageSources>
        </configuration>
        EOF

      # Install strictly from the store generated from pnpm-lock.yaml.
      - pnpm install --offline --frozen-lockfile
      - pnpm --filter @vortex/main exec electron-rebuild

      # Follow the native Linux packaging pipeline: build the workspace, create
      # the deploy tree, rebuild native addons in that tree, then ask
      # electron-builder only for the unpacked Linux payload used by Flatpak.
      - pnpm run build
      - pnpm nx run @vortex/main:publish
      - cd src/main/dist && ./node_modules/.bin/electron-rebuild
      - cd src/main/dist && USE_HARD_LINKS=false ./node_modules/.bin/electron-builder --config ./electron-builder.config.json --publish never --linux dir
'''
if old_build not in text:
    raise SystemExit("manifest legacy Yarn build block did not match")
text = text.replace(old_build, new_build, 1)

old_sources = '''      - type: dir
        path: ..
      - generated-sources.json
      - generated-nuget-sources.json
'''
new_sources = '''      - type: dir
        path: ..
      - type: archive
        url: https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz
        sha256: 620b6605ea4f62fc56a6d0a98733f479071d0321e03e486b522c7e9a74617431
        dest: flatpak-pnpm
      - generated-sources.json
      - generated-nuget-sources.json
'''
if old_sources not in text:
    raise SystemExit("manifest sources block did not match")
text = text.replace(old_sources, new_sources, 1)
manifest.write_text(text, encoding="utf-8")
