import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import stylexPlugin from "@stylexjs/rollup-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

import { loadHelmEnvironment, serverHostFromEnvironment } from "./scripts/environment.mjs";

const environment = loadHelmEnvironment();

const config = defineConfig(({ command, mode }) => {
  const host = command === "serve" ? serverHostFromEnvironment(environment) : undefined;

  return {
    build: {
      chunkSizeWarningLimit: 450,
      manifest: true,
    },
    envDir: false,
    resolve: {
      tsconfigPaths: true,
    },
    server: host ? { host } : undefined,
    plugins: [
      devtools(),
      stylexPlugin({
        dev: mode === "development",
        fileName: "stylex.css",
        runtimeInjection: mode === "development",
        useCSSLayers: true,
        unstable_moduleResolution: {
          type: "commonJS",
          rootDir: import.meta.dirname,
        },
      }),
      tanstackStart(),
      viteReact(),
      nitro(),
    ],
  };
});

export default config;
