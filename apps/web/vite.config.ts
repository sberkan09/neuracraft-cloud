import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev`: the API is proxied (API_URL, default http://localhost:8080).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/v1": { target: process.env.API_URL ?? "http://localhost:8080", changeOrigin: false } } },
  preview: { proxy: { "/v1": { target: process.env.API_URL ?? "http://localhost:8080", changeOrigin: false } } },
});
