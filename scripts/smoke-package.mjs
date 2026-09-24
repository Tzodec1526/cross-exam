import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const appDir = path.resolve(
  projectRoot,
  process.argv[2] ?? path.join("release", "win-unpacked")
);
const executablePath = path.join(appDir, "CrossExamination.exe");
const userData = await mkdtemp(path.join(os.tmpdir(), "cross-examination-smoke-"));

const SMOKE_MARKER = "[smoke] renderer loaded from";

try {
  const { exitCode, stdout } = await new Promise((resolve, reject) => {
    const child = spawn(
      executablePath,
      ["--smoke-test", `--user-data-dir=${userData}`],
      {
        env: {
          ...process.env,
          // A packaged app must ignore this even when inherited from a launcher.
          VITE_DEV_SERVER_URL: "http://127.0.0.1:1/",
          CROSS_EXAM_DEVTOOLS: "0",
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let collected = "";
    const collect = (chunk) => {
      if (collected.length < 1_000_000) collected += String(chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("packaged application smoke test timed out"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: collected });
    });
  });
  if (exitCode !== 0) {
    throw new Error(`packaged application exited with code ${String(exitCode)}`);
  }
  // Exit code 0 alone is not proof: a second-instance loser or an early quit
  // also exits 0. Require the renderer-loaded marker printed by main.ts.
  if (!stdout.includes(SMOKE_MARKER)) {
    throw new Error(
      "packaged application exited cleanly but never reported a loaded renderer" +
        (stdout.trim() ? `; output was:\n${stdout.slice(0, 4_000)}` : "")
    );
  }
  console.log("Packaged application loaded its production renderer successfully.");
} finally {
  await rm(userData, { recursive: true, force: true });
}
