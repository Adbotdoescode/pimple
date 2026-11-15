import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

// One Vite entry per Tauri window label (see docs/ARCHITECTURE.md).
const WINDOWS = ["brain", "bubble", "overlay", "card", "whiteboard", "settings"];

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
