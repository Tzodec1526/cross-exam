import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const localTool = "D:/dev/_tools/ensure-no-mcps.cjs";

// Local workstation: use the shared drive hygiene tool when present.
if (existsSync(localTool)) {
  const result = spawnSync(process.execPath, [localTool, projectRoot], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

// CI and other clones: only strip an accidental repo-root mcps/ cache.
const mcpsPath = path.join(projectRoot, "mcps");
if (existsSync(mcpsPath)) {
  await rm(mcpsPath, { recursive: true, force: true });
  if (existsSync(mcpsPath)) {
    throw new Error(`ensure-no-mcps: failed to remove ${mcpsPath}`);
  }
  console.log(`ensure-no-mcps: removed ${mcpsPath}`);
}
