import archiver from "archiver";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { matterDir } from "../paths.js";
import { getMatter } from "./matters.js";

/**
 * Zip a matter folder for backup or transfer. Returns the output .zip path.
 */
export async function exportMatterZip(matterId: string, destZipPath: string): Promise<string> {
  const matter = getMatter(matterId);
  if (!matter) throw new Error("Matter not found");

  const src = matterDir(matterId);
  if (!fs.existsSync(src)) throw new Error("Matter folder not found");

  const sourceRoot = fs.realpathSync.native(src);
  // Resolve 8.3 short names and junctions before creating any directory.
  // mkdir must not run until the canonical destination is outside the matter.
  const destination = canonicalDestinationOutsideMatter(sourceRoot, destZipPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const confirmed = canonicalDestinationOutsideMatter(sourceRoot, destination);
  assertRegularDestination(confirmed);
  const temporary = `${confirmed}.tmp-${process.pid}-${randomUUID()}`;

  try {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600, flush: true });
      const archive = archiver("zip", { zlib: { level: 9 } });
      let failure: Error | null = null;
      const fail = (error: unknown) => {
        if (failure) return;
        failure = error instanceof Error ? error : new Error(String(error));
        archive.abort();
        archive.destroy();
        output.destroy();
      };

      output.on("error", fail);
      archive.on("error", fail);
      // A missing/unreadable input must not produce a silently incomplete backup.
      archive.on("warning", fail);
      output.on("close", () => {
        // Wait for the descriptor to close before attempting cleanup on Windows.
        if (failure) reject(failure);
        else if (!output.writableFinished) reject(new Error("Matter export did not finish."));
        else resolve();
      });

      try {
        archive.pipe(output);
        addMatterFiles(
          archive,
          sourceRoot,
          matter.caption.replace(/[^\w.-]+/g, "_") || matterId
        );
        void archive.finalize().catch(fail);
      } catch (error) {
        fail(error);
      }
    });

    // Only replace an existing backup after a complete archive has been flushed.
    assertRegularDestination(confirmed);
    fs.renameSync(temporary, confirmed);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  return destZipPath;
}

function deepestExistingAncestor(target: string): string {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** Native real path of the file that would be created, without creating it. */
function canonicalDestinationOutsideMatter(sourceRoot: string, destination: string): string {
  const requested = path.resolve(destination);
  const ancestor = deepestExistingAncestor(requested);
  let canonicalAncestor: string;
  try {
    canonicalAncestor = fs.realpathSync.native(ancestor);
  } catch {
    throw new Error("Save the ZIP outside the matter folder to avoid overwriting case files.");
  }
  const suffix = path.relative(ancestor, requested);
  const canonicalDestination = suffix
    ? path.join(canonicalAncestor, suffix)
    : canonicalAncestor;
  assertOutsideMatter(sourceRoot, canonicalDestination);
  return canonicalDestination;
}

function addMatterFiles(
  archive: archiver.Archiver,
  directory: string,
  prefix: string
): void {
  for (const name of fs.readdirSync(directory)) {
    const full = path.join(directory, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(
        "Matter export refused a link or special file in the case folder. Remove it and export again."
      );
    }
    const entryName = path.posix.join(prefix, name);
    if (stat.isDirectory()) addMatterFiles(archive, full, entryName);
    else archive.file(full, { name: entryName });
  }
}

function assertOutsideMatter(sourceRoot: string, destination: string): void {
  const relative = path.relative(sourceRoot, destination);
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error("Save the ZIP outside the matter folder to avoid overwriting case files.");
  }
}

function assertRegularDestination(destination: string): void {
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("The export destination must be a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
