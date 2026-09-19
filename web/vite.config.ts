import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";
const hmrClientPort = Number(process.env.HMR_CLIENT_PORT ?? process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === "true",
      interval: 300,
    },
    hmr: {
      clientPort: hmrClientPort,
    },
    allowedHosts: ['freeware-unbroken-print.ngrok-free.dev'],
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
