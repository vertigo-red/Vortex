import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "vortex-launcher-"));
try {
  // Replace only the final executable with an argv recorder. Run the real shell
  // wrapper, so quoting and URL-to-option conversion are both exercised.
  const launcher = await readFile(new URL("./vortex", import.meta.url), "utf8");
  const recorder = join(directory, "record.mjs");
  const wrapper = join(directory, "vortex");
  await writeFile(recorder, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  await writeFile(
    wrapper,
    launcher.replace("exec /opt/vortex/vortex", 'exec "$TEST_NODE" "$TEST_RECORDER"'),
  );
  const url = "nxm://skyrimspecialedition/mods/123/files/456?key=test&expires=123";
  const cases = [
    [[], []],
    [[url], ["--download", url]],
    [["--help"], ["--help"]],
    [
      ["--download", url],
      ["--download", url],
    ],
    [
      ["--user-data", "/tmp/profile with spaces"],
      ["--user-data", "/tmp/profile with spaces"],
    ],
    [
      ["--", "literal ; $() and `backticks`"],
      ["--", "literal ; $() and `backticks`"],
    ],
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync("sh", [wrapper, ...args], {
      encoding: "utf8",
      env: { ...process.env, TEST_NODE: process.execPath, TEST_RECORDER: recorder },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  console.log(`Launcher argument checks passed: ${cases.length}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
