import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

// The dev meta CSP must allow the Vite HMR websocket, but that localhost
// allowance must not ship inside the packaged document. The app:// response
// header in electron/main.ts stays the primary enforcement; this transform
// removes the latent relaxation from the built HTML itself. frame-ancestors is
// omitted because it has no effect in a meta tag.
const PRODUCTION_META_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function hardenMetaCspForBuild(): Plugin {
  return {
    name: "harden-meta-csp",
    apply: "build",
    transformIndexHtml(html: string) {
      const pattern =
        /(<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content=")[^"]*(")/;
      if (!pattern.test(html)) {
        throw new Error("index.html is missing the Content-Security-Policy meta tag");
      }
      return html.replace(pattern, `$1${PRODUCTION_META_CSP}$2`);
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    hardenMetaCspForBuild(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron", "ws", "pdf-parse", "mammoth", "minisearch", "uuid", "archiver"],
            },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            // package.json is "type":"module"; emit CJS preload as .cjs so require() works
            rollupOptions: {
              output: {
                format: "cjs",
                entryFileNames: "preload.cjs",
                inlineDynamicImports: true,
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  server: {
    port: 5173,
  },
});
