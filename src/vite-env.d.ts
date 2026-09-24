/// <reference types="vite/client" />

import type { DesktopApi } from "../electron/preload";

declare global {
  interface Window {
    api: DesktopApi;
  }
}

export {};
