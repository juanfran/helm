import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";

import { assertClientBundleBudget, formatClientBundleReport } from "./client-bundle-budget.mjs";
import { HELM_PROJECT_ROOT } from "./environment.mjs";

const BUILD_MANIFEST_VERSION = 1;
const BUILD_MANIFEST_PATH = ".output/helm-build.json";
const SERVER_ENTRY_PATH = ".output/server/index.mjs";
const buildInputs = [
  "src",
  "public",
  "scripts",
  "components.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsr.config.json",
  "vite.config.ts",
];

function collectFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];

  return readdirSync(path, { withFileTypes: true })
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return collectFiles(child);
      return entry.isFile() ? [child] : [];
    });
}

export function computeBuildFingerprint(projectRoot = HELM_PROJECT_ROOT) {
  const hash = createHash("sha256");
  const files = buildInputs
    .flatMap((input) => collectFiles(join(projectRoot, input)))
    .toSorted((left, right) => left.localeCompare(right));

  for (const file of files) {
    hash.update(relative(projectRoot, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export function productionBuildStatus(projectRoot = HELM_PROJECT_ROOT) {
  if (!existsSync(join(projectRoot, SERVER_ENTRY_PATH))) return "missing-output";

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(projectRoot, BUILD_MANIFEST_PATH), "utf8"));
  } catch {
    return "missing-manifest";
  }

  if (manifest.version !== BUILD_MANIFEST_VERSION || typeof manifest.fingerprint !== "string") {
    return "invalid-manifest";
  }

  return manifest.fingerprint === computeBuildFingerprint(projectRoot)
    ? "current"
    : "inputs-changed";
}

function writeBuildManifest(projectRoot, fingerprint) {
  mkdirSync(join(projectRoot, ".output"), { recursive: true });
  writeFileSync(
    join(projectRoot, BUILD_MANIFEST_PATH),
    `${JSON.stringify({
      version: BUILD_MANIFEST_VERSION,
      fingerprint,
    })}\n`,
  );
}

function invalidateBuildManifest(projectRoot) {
  writeBuildManifest(projectRoot, null);
}

function runNode(command, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...arguments_], options);
    child.once("error", () => reject(new Error("Helm could not start the build command.")));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? `The Helm production build stopped after ${signal}.`
              : `The Helm production build exited with status ${code ?? "unknown"}.`,
          ),
        );
    });
  });
}

export async function buildProduction(projectRoot = HELM_PROJECT_ROOT) {
  const viteCli = join(projectRoot, "node_modules/vite/bin/vite.js");
  if (!existsSync(viteCli)) {
    throw new Error("Vite is not installed. Run pnpm install before building Helm.");
  }

  const fingerprint = computeBuildFingerprint(projectRoot);
  invalidateBuildManifest(projectRoot);
  await runNode(viteCli, ["build"], {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });

  const bundleReport = assertClientBundleBudget(projectRoot);
  process.stdout.write(`${formatClientBundleReport(bundleReport)}\n`);

  if (computeBuildFingerprint(projectRoot) !== fingerprint) {
    throw new Error("Helm inputs changed during the production build. Run the build again.");
  }
  if (!existsSync(join(projectRoot, SERVER_ENTRY_PATH))) {
    throw new Error("The Helm production build did not create its server entry point.");
  }

  writeBuildManifest(projectRoot, fingerprint);
}

export async function ensureProductionBuild(projectRoot = HELM_PROJECT_ROOT) {
  const status = productionBuildStatus(projectRoot);
  if (status === "current") return false;

  process.stdout.write(`[helm] Production build is ${status}; rebuilding.\n`);
  await buildProduction(projectRoot);
  return true;
}
