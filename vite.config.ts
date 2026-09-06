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
      // Per-tab log-mirroring SSE can exhaust Chrome's HTTP/1 connection pool.
      // Keep the devtools panels; inspect server logs in the terminal.
      devtools({ consolePiping: { enabled: false } }),
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
      nitro({
        rolldownConfig: {
          output: {
            codeSplitting: {
              groups: [
                {
                  // Keep Start's server runtime and route registry together. Re-chunking these
                  // creates an initialization cycle through createSsrRpc. Client routes stay split.
                  name: "start-ssr",
                  test: /[/\\]\.nitro[/\\]vite[/\\]services[/\\]ssr[/\\]/,
                },
              ],
            },
          },
        },
      }),
    ],
  };
});

export default config;
