import path from "node:path";
import { app } from "electron";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertMatterId(matterId: string): string {
  if (!UUID_RE.test(matterId)) {
    throw new Error("Invalid matter id");
  }
  return matterId;
}

export function getDataRoot(): string {
  // Packaged: userData. Dev/solo: project working directory (matters/ next to package.json).
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "cross-examination");
  }
  return path.resolve(process.cwd());
}

export function mattersRoot(): string {
  return path.join(getDataRoot(), "matters");
}

export function settingsPath(): string {
  return path.join(getDataRoot(), "data", "settings.json");
}

export function matterDir(matterId: string): string {
  return path.join(mattersRoot(), assertMatterId(matterId));
}

export function matterMetaPath(matterId: string): string {
  return path.join(matterDir(matterId), "matter.json");
}

export function documentsDir(matterId: string): string {
  return path.join(matterDir(matterId), "documents");
}

export function indexPath(matterId: string): string {
  return path.join(matterDir(matterId), "index.json");
}

export function personasPath(matterId: string): string {
  return path.join(matterDir(matterId), "personas.json");
}

export function sessionsDir(matterId: string): string {
  return path.join(matterDir(matterId), "sessions");
}
