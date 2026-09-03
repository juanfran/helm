import { defineConfig } from "vitest/config";
import stylexPlugin from "@stylexjs/rollup-plugin";

export default defineConfig({
  plugins: [
    stylexPlugin({
      dev: true,
      runtimeInjection: true,
      unstable_moduleResolution: {
        type: "commonJS",
        rootDir: import.meta.dirname,
      },
    }),
  ],
  test: {
    environment: "node",
  },
});
