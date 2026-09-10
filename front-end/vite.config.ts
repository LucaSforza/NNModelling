import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // GitHub Pages serves project sites below /<repository>/; locally Vite stays
  // available from the root URL.
  // Electron loads the renderer through app://nnmodelling, where absolute
  // asset URLs would escape the custom protocol. Web builds retain `/` (or
  // the GitHub Pages override) unless the desktop build opts into `./`.
  base: process.env.VITE_BASE_PATH ?? (process.env.VITE_DESKTOP === "1" ? "./" : "/"),
  plugins: [
    svelte({
      emitCss: false,
    }),
  ],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:9339",
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  optimizeDeps: {
    exclude: ["@xyflow/svelte"],
  },
});
