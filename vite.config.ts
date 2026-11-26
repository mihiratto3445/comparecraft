import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // Transform the app modules up front so the first webview load does not pay
    // the cold-transform cost (several seconds on a cold cache).
    warmup: { clientFiles: ["./src/**/*.{ts,tsx}"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "help", test: /\/src\/help\/|\/node_modules\/marked\// }],
        },
      },
    },
  },
});
