import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

// One Vite entry per Tauri window label (see docs/ARCHITECTURE.md).
const WINDOWS = ["brain", "bubble", "overlay", "card", "whiteboard", "settings", "gizmo"];

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@shared": resolve(__dirname, "./shared"),
      "@": resolve(__dirname, "./src"),
    },
  },

  build: {
    rollupOptions: {
      input: Object.fromEntries(
        WINDOWS.map((w) => [w, resolve(__dirname, `src/windows/${w}/index.html`)]),
      ),
    },
  },

  // Pre-bundle every dependency up front, so a newly imported package or subpath never makes
  // Vite re-optimise at runtime and full-reload every webview (that kills a live session).
  optimizeDeps: {
    include: [
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "@tauri-apps/api/webviewWindow",
      "@tauri-apps/api/dpi",
      "@tauri-apps/api/path",
      "@tauri-apps/api/app",
      "@tauri-apps/api/menu",
      "@tauri-apps/api/tray",
      "@tauri-apps/api/image",
      "@tauri-apps/plugin-log",
      "@tauri-apps/plugin-store",
      "@tauri-apps/plugin-dialog",
      "@tauri-apps/plugin-fs",
      "@tauri-apps/plugin-opener",
      "@tauri-apps/plugin-os",
      "@tauri-apps/plugin-process",
      "@anthropic-ai/sdk",
      "partial-json",
      "zod",
      "zustand",
      "zustand/vanilla",
      "motion",
      "motion/react",
      "framer-motion",
      "lucide-react",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
