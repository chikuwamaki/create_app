import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "path";

export default defineConfig({
  root: path.resolve(__dirname, "admin"),
  envDir: __dirname,
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "dist-admin"),
    emptyOutDir: true
  }
});
