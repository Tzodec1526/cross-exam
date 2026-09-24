import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { extractFile, listPackage } from "@electron/asar";
import {
  FuseState,
  FuseV1Options,
  getCurrentFuseWire,
} from "@electron/fuses";

const projectRoot = path.resolve(import.meta.dirname, "..");
const appDir = path.resolve(
  projectRoot,
  process.argv[2] ?? path.join("release", "win-unpacked")
);
const resourcesDir = path.join(appDir, "resources");
const archivePath = path.join(resourcesDir, "app.asar");
const executablePath = path.join(appDir, "CrossExamination.exe");

function fail(message) {
  throw new Error(`Package verification failed: ${message}`);
}

await Promise.all([access(archivePath), access(executablePath)]).catch(() => {
  fail(`expected unpacked application at ${appDir}`);
});

const archiveStats = await stat(archivePath);
if (archiveStats.size < 1_000_000) fail("app.asar is unexpectedly small");

const entries = new Set(
  listPackage(archivePath, { isPack: false }).map((entry) =>
    entry.replaceAll("\\", "/").replace(/^\/+/, "")
  )
);

const requiredFiles = [
  "package.json",
  "dist/index.html",
  "dist-electron/main.js",
  "dist-electron/preload.cjs",
  "node_modules/mammoth/package.json",
  "node_modules/minisearch/package.json",
  "node_modules/pdf-parse/package.json",
  "node_modules/uuid/package.json",
  "node_modules/ws/package.json",
];
for (const required of requiredFiles) {
  if (!entries.has(required)) fail(`missing ${required}`);
}

const allowedRoots = new Set(["package.json", "dist", "dist-electron", "node_modules"]);
const forbiddenRootFile = /^(?:\.env(?:\..*)?|vite\.config\.|tsconfig|vitest\.)/i;
for (const entry of entries) {
  const root = entry.split("/", 1)[0] ?? "";
  if (!allowedRoots.has(root)) fail(`unexpected root entry ${entry}`);
  if (forbiddenRootFile.test(entry)) fail(`developer or secret-bearing file included: ${entry}`);
}

// dist-electron must contain exactly the current build's outputs. A stale file
// from an older build (for example a superseded preload) would otherwise ship
// silently and could be picked up by the runtime preload fallback chain.
const expectedDistElectron = new Set(["dist-electron/main.js", "dist-electron/preload.cjs"]);
const actualDistElectron = new Set(
  [...entries].filter((entry) => entry.startsWith("dist-electron/"))
);
for (const expected of expectedDistElectron) {
  if (!actualDistElectron.has(expected)) fail(`missing ${expected}`);
}
for (const actual of actualDistElectron) {
  if (!expectedDistElectron.has(actual)) fail(`stale or unexpected build output ${actual}`);
}

const packagedMetadata = JSON.parse(extractFile(archivePath, "package.json").toString("utf8"));
if (packagedMetadata.main !== "dist-electron/main.js") fail("package main entry is incorrect");
if (packagedMetadata.name !== "cross-examination") fail("package identity is incorrect");
if (packagedMetadata.devDependencies) fail("development dependencies leaked into package metadata");

await access(path.join(resourcesDir, "app")).then(
  () => fail("an unpacked app directory can shadow the integrity-protected ASAR"),
  () => undefined
);

const fuses = await getCurrentFuseWire(executablePath);
const expectedFuses = new Map([
  [FuseV1Options.RunAsNode, FuseState.DISABLE],
  [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
  [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
  [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
  [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
]);
for (const [fuse, expected] of expectedFuses) {
  if (fuses[fuse] !== expected) fail(`Electron fuse ${fuse} is not in the required state`);
}

// Files under app.asar.unpacked are NOT covered by embedded ASAR integrity
// validation. Pin the expected smart-unpacked set (mammoth's jszip dependency)
// so nothing else can ride outside the integrity boundary unnoticed.
const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
const unpackedExists = await access(unpackedDir).then(
  () => true,
  () => false
);
if (unpackedExists) {
  const unpackedRoots = await readdir(unpackedDir);
  if (unpackedRoots.length !== 1 || unpackedRoots[0] !== "node_modules") {
    fail(`unexpected app.asar.unpacked contents: ${unpackedRoots.join(", ")}`);
  }
  const unpackedModules = await readdir(path.join(unpackedDir, "node_modules"));
  const allowedUnpacked = new Set(["jszip"]);
  for (const moduleName of unpackedModules) {
    if (!allowedUnpacked.has(moduleName)) {
      fail(`unexpected module outside the integrity-validated ASAR: ${moduleName}`);
    }
  }
}

console.log(
  `Verified ${entries.size} ASAR entries, release allowlist, unpacked allowlist, metadata, and Electron fuses.`
);
