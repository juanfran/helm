import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import stylexPlugin from "@stylexjs/rollup-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

const config = defineConfig(({ mode }) => ({
  resolve: {
    tsconfigPaths: true,
  },
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
}));

export default config;
