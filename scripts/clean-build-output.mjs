import { rm } from "node:fs/promises";
import path from "node:path";

// The renderer build empties dist/ itself, but the two electron sub-builds
// share dist-electron/ without emptying it. A renamed entry (for example an
// older preload) would otherwise persist and ship inside the package. Clean
// both outputs so every build starts from nothing.
const projectRoot = path.resolve(import.meta.dirname, "..");
for (const target of ["dist", "dist-electron"]) {
  await rm(path.join(projectRoot, target), { recursive: true, force: true });
}
