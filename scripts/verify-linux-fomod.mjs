import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
if (process.platform !== "linux" || process.argv.length !== 3) {
  throw new Error("Usage on Linux: node scripts/verify-linux-fomod.mjs <packaged-resources>");
}
const packageRoot = path.resolve(
  process.argv[2],
  "app.asar.unpacked/node_modules/@nexusmods/fomod-installer-native",
);
const binding = path.join(packageRoot, "build/Release/modinstaller.node");
const library = path.join(packageRoot, "ModInstaller.Native.so");
await Promise.all([access(binding), access(library)]);
const { stdout: runpath } = await exec("patchelf", ["--print-rpath", binding]);
if (runpath.trim() !== "$ORIGIN:$ORIGIN/../..") {
  throw new Error(`FOMOD has a non-portable library search path: ${runpath.trim()}`);
}

const temporary = await mkdtemp(path.join(tmpdir(), "vortex-relocated-fomod-"));
try {
  const relocated = path.join(temporary, "package");
  const relocatedBinding = path.join(relocated, "build/Release/modinstaller.node");
  await mkdir(path.dirname(relocatedBinding), { recursive: true });
  await copyFile(binding, relocatedBinding);
  // Only the package-root library is copied, proving the ../.. lookup also works.
  await copyFile(library, path.join(relocated, "ModInstaller.Native.so"));
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const addon = require(process.argv[1]);
    const raw = addon.ModInstaller.testSupported(
      ['fomod/ModuleConfig.xml', 'Textures/Example.dds'], ['XmlScript']);
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    assert.equal(result.supported, true);
    const logger = new addon.Logger(() => {});
    logger.setCallbacks();

    (async () => {
      const archive = path.join(process.argv[2], 'Skyrim LE FOMOD проверка');
      await fs.mkdir(path.join(archive, 'fomod'), { recursive: true });
      await fs.writeFile(path.join(archive, 'Base.esp'), 'available file');
      await fs.writeFile(path.join(archive, 'SKSE.esp'), 'unavailable file');
      const requirement = '<skseDependency version="1.7.3" />';
      const config = (mandatory, groupType = 'SelectAny') =>
        '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
        '<moduleName>SKSE package probe</moduleName>' +
        (mandatory ? '<moduleDependencies>' + requirement + '</moduleDependencies>' : '') +
        '<installSteps order="Explicit"><installStep name="Files">' +
        '<optionalFileGroups order="Explicit"><group name="Mod" type="' + groupType + '">' +
        '<plugins order="Explicit"><plugin name="SKSE"><description>Needs SKSE</description>' +
        '<files><file source="SKSE.esp" destination="SKSE.esp" /></files>' +
        '<typeDescriptor><dependencyType><defaultType name="NotUsable" /><patterns>' +
        '<pattern><dependencies>' + requirement + '</dependencies><type name="Optional" />' +
        '</pattern></patterns></dependencyType></typeDescriptor></plugin>' +
        '<plugin name="Base"><description>Available</description>' +
        '<files><file source="Base.esp" destination="Base.esp" /></files>' +
        '<typeDescriptor><type name="Required" /></typeDescriptor></plugin></plugins>' +
        '</group></optionalFileGroups></installStep></installSteps></config>';

      for (const scenario of [
        { version: '', groupType: 'SelectAny' },
        { version: '', groupType: 'SelectAll' },
        { version: 'invalid', groupType: 'SelectAny' },
        { version: '1.7.3', groupType: 'SelectAll' },
        { version: '', mandatory: true },
        { version: '', preset: true },
        { version: '1.7.3', preset: true },
      ]) {
        await fs.writeFile(path.join(archive, 'fomod/ModuleConfig.xml'), config(scenario.mandatory, scenario.groupType));
        let continueInstall;
        let displayed = false;
        let callbackError;
        const installer = new addon.ModInstaller(
          () => [], () => '1.0.0', () => '1.9.32.0', () => scenario.version,
          (_name, _image, _select, cont) => { continueInstall = cont; },
          () => {},
          (steps, currentStep) => {
            displayed = true;
            try {
              const option = steps[currentStep].optionalFileGroups.group[0].options[0];
              if (scenario.version === '1.7.3') {
                assert.equal(option.type, 'Optional');
                assert.equal(option.selected, true);
              } else {
                assert.equal(option.type, 'NotUsable');
                assert.equal(option.selected, false);
                assert.match(option.conditionMsg, /skse v1\\.7\\.3/);
                assert.doesNotMatch(option.conditionMsg, /Passed/);
              }
            } catch (error) { callbackError = error; }
            setImmediate(() => continueInstall(true, currentStep));
          },
        );
        const installed = await installer.install(
          ['fomod/ModuleConfig.xml', 'Base.esp', 'SKSE.esp'], [], 'Data', archive,
          scenario.preset ? [{ name: 'Files', groups: [{ name: 'Mod', choices: [{ name: 'SKSE', idx: 0 }] }] }] : undefined,
          false, true,
        );
        if (callbackError) throw callbackError;
        const copies = installed.instructions.filter(item => item.type === 'copy');
        if (scenario.mandatory) {
          assert.equal(displayed, false);
          assert.equal(copies.length, 0);
          assert.ok(installed.instructions.some(item => item.type === 'error' && item.value === 'fatal'));
        } else {
          assert.equal(displayed, !scenario.preset);
          assert.equal(copies.length, scenario.version === '1.7.3' ? 2 : 1);
          assert.ok(copies.some(item => item.source === 'Base.esp'));
          assert.equal(copies.some(item => item.source === 'SKSE.esp'), scenario.version === '1.7.3');
        }
      }
      console.log('Relocated native FOMOD passed 7 SKSE dependency and option checks');
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const { stdout } = await exec(process.execPath, ["-e", probe, relocatedBinding, temporary], {
    cwd: temporary,
    env,
    timeout: 30_000,
  });
  console.log(stdout.trim());
} finally {
  await rm(temporary, { recursive: true, force: true });
}
