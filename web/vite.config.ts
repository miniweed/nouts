import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// En desarrollo, /s/<token> lo sirve este plugin; en producción lo sirve Express.
function shareRewrite(): Plugin {
  return {
    name: "share-rewrite",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith("/s/")) req.url = "/share.html";
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), shareRewrite()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        share: resolve(__dirname, "share.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
