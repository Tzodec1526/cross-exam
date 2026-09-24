import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Remote production-finalize tests import electron; mock it in unit tests.
      electron: path.join(root, "test/mocks/electron.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    restoreMocks: true,
    include: [
      "tests/**/*.{test,spec}.{ts,tsx}",
      "electron/**/*.test.ts",
      "src/**/*.test.ts",
    ],
  },
});
