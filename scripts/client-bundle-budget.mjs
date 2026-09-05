import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { HELM_PROJECT_ROOT } from "./environment.mjs";

export const CLIENT_BUNDLE_MANIFEST_PATH = ".output/public/.vite/manifest.json";

export const CLIENT_BUNDLE_BUDGETS = Object.freeze({
  shell: Object.freeze({ rawBytes: 500_000, gzipBytes: 150_000 }),
  asset: Object.freeze({ rawBytes: 450_000, gzipBytes: 140_000 }),
  dynamicIncrement: Object.freeze({ rawBytes: 500_000, gzipBytes: 160_000 }),
  navigation: Object.freeze({
    "/": Object.freeze({ rawBytes: 900_000, gzipBytes: 280_000 }),
    "/$projectId/tasks": Object.freeze({ rawBytes: 900_000, gzipBytes: 280_000 }),
    "/$projectId/dashboard": Object.freeze({ rawBytes: 900_000, gzipBytes: 280_000 }),
    "/$projectId/activity": Object.freeze({ rawBytes: 900_000, gzipBytes: 280_000 }),
    "/$projectId/settings": Object.freeze({ rawBytes: 900_000, gzipBytes: 280_000 }),
    "/$projectId/search": Object.freeze({ rawBytes: 850_000, gzipBytes: 260_000 }),
    "/$projectId/views/$viewId": Object.freeze({ rawBytes: 850_000, gzipBytes: 260_000 }),
    "/$projectId/tasks/$taskId": Object.freeze({
      rawBytes: 1_050_000,
      gzipBytes: 330_000,
    }),
  }),
});

// A source belongs here only when the route requests it without user intent. The checker adds each
// source's complete static closure to that navigation's cumulative payload. Remove a source when it
// becomes a static route dependency; add new automatic dynamic descendants before shipping them.
export const CLIENT_NAVIGATION_CRITICAL_SOURCES = Object.freeze({
  "/": Object.freeze(["src/features/projects/project-landing.tsx"]),
  "/$projectId/tasks": Object.freeze([]),
  "/$projectId/dashboard": Object.freeze(["src/features/dashboard/operational-dashboard.tsx"]),
  "/$projectId/activity": Object.freeze(["src/features/activity/project-activity-feed.tsx"]),
  "/$projectId/settings": Object.freeze(["src/features/projects/project-review-mode-control.tsx"]),
  "/$projectId/search": Object.freeze([]),
  "/$projectId/views/$viewId": Object.freeze([]),
  "/$projectId/tasks/$taskId": Object.freeze(["src/features/tasks/task-detail-panel.tsx"]),
});

const routeSources = Object.freeze({
  "/": "src/routes/index.tsx",
  "/$projectId/tasks": "src/routes/$projectId.tasks.index.tsx",
  "/$projectId/dashboard": "src/routes/$projectId.dashboard.tsx",
  "/$projectId/activity": "src/routes/$projectId.activity.tsx",
  "/$projectId/settings": "src/routes/$projectId.settings.tsx",
  "/$projectId/search": "src/routes/$projectId.search.tsx",
  "/$projectId/views/$viewId": "src/routes/$projectId.views.$viewId.tsx",
  "/$projectId/tasks/$taskId": "src/routes/$projectId.tasks.$taskId.tsx",
});
const routeSplitProperties = Object.freeze(["loader", "component", "errorComponent"]);
const requiredFeatureSources = Object.freeze([
  Object.freeze({
    label: "operational dashboard",
    source: "src/features/dashboard/operational-dashboard.tsx",
  }),
  Object.freeze({ label: "rich-text editor", source: "src/features/tasks/rich-text-editor.tsx" }),
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readManifest(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Helm could not read the client bundle manifest at ${path}: ${detail}`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error(`The client bundle manifest at ${path} must be a JSON object.`);
  }
  return parsed;
}

function normalizeSource(value) {
  return value.replaceAll("\\", "/");
}

function entrySource(key, entry) {
  return normalizeSource(typeof entry.src === "string" ? entry.src : key);
}

function sourceParts(source) {
  const queryIndex = source.indexOf("?");
  if (queryIndex < 0) return { path: source, search: new URLSearchParams() };
  return {
    path: source.slice(0, queryIndex),
    search: new URLSearchParams(source.slice(queryIndex + 1)),
  };
}

function sourcePathMatches(source, expected) {
  const { path } = sourceParts(source);
  return path === expected || path.endsWith(`/${expected}`);
}

function stableSource(source) {
  const normalized = normalizeSource(source);
  const srcIndex = normalized.lastIndexOf("/src/");
  return srcIndex < 0 ? normalized : normalized.slice(srcIndex + 1);
}

function validatedEntries(manifest) {
  return Object.entries(manifest)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!isRecord(value) || typeof value.file !== "string" || value.file.length === 0) {
        throw new Error(`Client bundle manifest entry ${JSON.stringify(key)} has no output file.`);
      }
      if (value.imports !== undefined && !Array.isArray(value.imports)) {
        throw new Error(`Client bundle manifest entry ${JSON.stringify(key)} has invalid imports.`);
      }
      if (value.dynamicImports !== undefined && !Array.isArray(value.dynamicImports)) {
        throw new Error(
          `Client bundle manifest entry ${JSON.stringify(key)} has invalid dynamic imports.`,
        );
      }
      return [key, value];
    });
}

function isJavaScript(file) {
  return /\.m?js$/u.test(file);
}

function findRequiredEntry(entries, expectedSource, splitProperty) {
  const matches = entries.filter(([key, entry]) => {
    const source = entrySource(key, entry);
    if (!sourcePathMatches(source, expectedSource)) return false;
    return splitProperty === undefined
      ? sourceParts(source).search.size === 0
      : sourceParts(source).search.get("tsr-split") === splitProperty;
  });
  return matches;
}

function addRequiredEntryViolation(violations, label, matches, shellFiles, dynamicEntryKeys) {
  if (matches.length === 0) {
    violations.push({
      code: "required-entry-missing",
      target: label,
      message: `${label}: required dynamic manifest entry is missing`,
    });
    return;
  }
  if (matches.length > 1) {
    violations.push({
      code: "required-entry-ambiguous",
      target: label,
      message: `${label}: expected one dynamic manifest entry but found ${matches.length}`,
    });
  }
  for (const [key, entry] of matches) {
    if (!dynamicEntryKeys.has(key)) {
      violations.push({
        code: "required-entry-not-dynamic",
        target: label,
        message: `${label}: manifest entry ${JSON.stringify(key)} is neither flagged nor referenced as a dynamic entry`,
      });
    }
    if (shellFiles.has(entry.file)) {
      violations.push({
        code: "required-entry-in-shell",
        target: label,
        message: `${label}: dynamic asset ${JSON.stringify(entry.file)} is reachable from the client shell`,
      });
    }
  }
}

function resolveAssetPath(publicRoot, file) {
  const absolutePath = resolve(publicRoot, file);
  const pathFromPublicRoot = relative(publicRoot, absolutePath);
  if (
    pathFromPublicRoot === ".." ||
    pathFromPublicRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromPublicRoot) ||
    pathFromPublicRoot === ""
  ) {
    throw new Error(
      `Client bundle manifest contains an unsafe asset path: ${JSON.stringify(file)}.`,
    );
  }
  return absolutePath;
}

function measureAssets(files, assetsByFile) {
  let rawBytes = 0;
  let gzipBytes = 0;
  const sortedFiles = [...files].toSorted((left, right) => left.localeCompare(right));
  for (const file of sortedFiles) {
    const asset = assetsByFile.get(file);
    if (!asset) continue;
    rawBytes += asset.rawBytes;
    gzipBytes += asset.gzipBytes;
  }
  return { files: sortedFiles, rawBytes, gzipBytes };
}

function addLimitViolations(violations, code, target, measurement, budget) {
  for (const metric of ["rawBytes", "gzipBytes"]) {
    if (measurement[metric] <= budget[metric]) continue;
    const metricLabel = metric === "rawBytes" ? "raw" : "gzip";
    violations.push({
      code,
      target,
      metric,
      actualBytes: measurement[metric],
      limitBytes: budget[metric],
      message: `${target}: ${metricLabel} actual ${formatDiagnosticBytes(measurement[metric])}, limit ${formatDiagnosticBytes(budget[metric])}, excess ${formatDiagnosticBytes(measurement[metric] - budget[metric])}`,
    });
  }
}

function compareViolations(left, right) {
  return (
    left.code.localeCompare(right.code) ||
    left.target.localeCompare(right.target) ||
    (left.metric ?? "").localeCompare(right.metric ?? "") ||
    left.message.localeCompare(right.message)
  );
}

export function inspectClientBundle(projectRoot = HELM_PROJECT_ROOT, options = {}) {
  const manifestPath = resolve(projectRoot, options.manifestPath ?? CLIENT_BUNDLE_MANIFEST_PATH);
  const publicRoot = dirname(dirname(manifestPath));
  const manifest = readManifest(manifestPath);
  const entries = validatedEntries(manifest);
  const entriesByKey = new Map(entries);
  const violations = [];
  const missingImports = new Set();
  const missingDynamicImports = new Set();
  const dynamicParents = new Map();
  const staticParents = new Map();
  const dynamicEntryKeys = new Set(
    entries.filter(([, entry]) => entry.isDynamicEntry === true).map(([key]) => key),
  );

  for (const [parentKey, entry] of entries) {
    for (const importedKey of entry.imports ?? []) {
      if (typeof importedKey !== "string") {
        throw new Error(
          `Client bundle manifest entry ${JSON.stringify(parentKey)} has a non-string import.`,
        );
      }
      const parents = staticParents.get(importedKey) ?? [];
      parents.push(parentKey);
      staticParents.set(importedKey, parents);
    }
    for (const dynamicKey of entry.dynamicImports ?? []) {
      if (typeof dynamicKey !== "string") {
        throw new Error(
          `Client bundle manifest entry ${JSON.stringify(parentKey)} has a non-string dynamic import.`,
        );
      }
      if (!entriesByKey.has(dynamicKey)) missingDynamicImports.add(dynamicKey);
      else dynamicEntryKeys.add(dynamicKey);
      const parents = dynamicParents.get(dynamicKey) ?? [];
      parents.push(parentKey);
      dynamicParents.set(dynamicKey, parents);
    }
  }

  const assetsByFile = new Map();
  const visitedAssetFiles = new Set();
  for (const [, entry] of entries) {
    if (!isJavaScript(entry.file) || visitedAssetFiles.has(entry.file)) continue;
    visitedAssetFiles.add(entry.file);
    const assetPath = resolveAssetPath(publicRoot, entry.file);
    let bytes;
    try {
      bytes = readFileSync(assetPath);
    } catch (error) {
      const reason =
        error && typeof error === "object" && error.code === "ENOENT"
          ? "output file is missing"
          : "output file is unreadable";
      violations.push({
        code: "asset-file-missing",
        target: entry.file,
        message: `asset ${JSON.stringify(entry.file)}: ${reason}`,
      });
      continue;
    }
    assetsByFile.set(entry.file, {
      file: entry.file,
      rawBytes: bytes.byteLength,
      gzipBytes: gzipSync(bytes, { level: 9, mtime: 0 }).byteLength,
    });
  }

  function closure(entryKeys) {
    const files = new Set();
    const pending = [...entryKeys];
    const visited = new Set();
    while (pending.length > 0) {
      const key = pending.pop();
      if (key === undefined || visited.has(key)) continue;
      visited.add(key);
      const entry = entriesByKey.get(key);
      if (!entry) {
        missingImports.add(key);
        continue;
      }
      if (isJavaScript(entry.file)) files.add(entry.file);
      for (const importedKey of entry.imports ?? []) {
        if (typeof importedKey !== "string") {
          throw new Error(
            `Client bundle manifest entry ${JSON.stringify(key)} has a non-string import.`,
          );
        }
        pending.push(importedKey);
      }
    }
    return files;
  }

  const clientEntries = entries.filter(
    ([, entry]) => entry.isEntry === true && isJavaScript(entry.file),
  );
  if (clientEntries.length !== 1) {
    violations.push({
      code: "client-entry-count",
      target: "client shell",
      message: `client shell: expected one JavaScript entry but found ${clientEntries.length}`,
    });
  }
  const shellFiles = closure(clientEntries.map(([key]) => key));
  const clientEntryKeys = new Set(clientEntries.map(([key]) => key));
  const shell = measureAssets(shellFiles, assetsByFile);

  const routeEntries = new Map();
  const routeEntryOwners = new Map();
  for (const [route, routeSource] of Object.entries(routeSources)) {
    const propertyEntries = new Map();
    for (const property of routeSplitProperties) {
      const label = `route ${route} ${property}`;
      const matches = findRequiredEntry(entries, routeSource, property);
      addRequiredEntryViolation(violations, label, matches, shellFiles, dynamicEntryKeys);
      if (matches.length > 0) {
        propertyEntries.set(property, matches[0][0]);
        routeEntryOwners.set(matches[0][0], route);
      }
    }
    routeEntries.set(route, propertyEntries);
  }

  const requiredFeatureEntries = [];
  for (const requiredFeature of requiredFeatureSources) {
    const label = `feature ${requiredFeature.label}`;
    const matches = findRequiredEntry(entries, requiredFeature.source);
    addRequiredEntryViolation(violations, label, matches, shellFiles, dynamicEntryKeys);
    requiredFeatureEntries.push({ label, matches });
  }

  const assets = [...assetsByFile.values()].toSorted((left, right) =>
    left.file.localeCompare(right.file),
  );
  for (const asset of assets) {
    addLimitViolations(
      violations,
      "asset-budget",
      `asset ${asset.file}`,
      asset,
      options.budgets?.asset ?? CLIENT_BUNDLE_BUDGETS.asset,
    );
  }
  addLimitViolations(
    violations,
    "shell-budget",
    "client shell",
    shell,
    options.budgets?.shell ?? CLIENT_BUNDLE_BUDGETS.shell,
  );

  const routeInitialNavigations = {};
  for (const [route, propertyEntries] of routeEntries) {
    const navigationFiles = new Set(shellFiles);
    for (const key of propertyEntries.values()) {
      for (const file of closure([key])) navigationFiles.add(file);
    }
    routeInitialNavigations[route] = measureAssets(navigationFiles, assetsByFile);
  }

  function reachableDynamicEntryKeys(entryKeys) {
    const reachable = new Set();
    const pending = [...entryKeys];
    const visited = new Set();
    while (pending.length > 0) {
      const key = pending.pop();
      if (key === undefined || visited.has(key)) continue;
      visited.add(key);
      const entry = entriesByKey.get(key);
      if (!entry) continue;
      for (const importedKey of entry.imports ?? []) {
        if (typeof importedKey !== "string") {
          throw new Error(
            `Client bundle manifest entry ${JSON.stringify(key)} has a non-string import.`,
          );
        }
        pending.push(importedKey);
      }
      for (const dynamicKey of entry.dynamicImports ?? []) {
        if (!entriesByKey.has(dynamicKey)) continue;
        reachable.add(dynamicKey);
        pending.push(dynamicKey);
      }
    }
    return reachable;
  }

  const navigationCriticalSources =
    options.navigationCriticalSources ?? CLIENT_NAVIGATION_CRITICAL_SOURCES;
  const navigations = {};
  for (const [route, propertyEntries] of routeEntries) {
    const navigationFiles = new Set(routeInitialNavigations[route]?.files ?? shellFiles);
    const reachableDynamicEntries = reachableDynamicEntryKeys([...propertyEntries.values()]);
    const requiredSources = [...(navigationCriticalSources[route] ?? [])].toSorted((left, right) =>
      left.localeCompare(right),
    );
    for (const source of requiredSources) {
      const target = `navigation ${route} source ${source}`;
      const matches = findRequiredEntry(entries, source);
      if (matches.length === 0) {
        violations.push({
          code: "navigation-entry-missing",
          target,
          message: `${target}: required manifest entry is missing`,
        });
        continue;
      }
      if (matches.length > 1) {
        violations.push({
          code: "navigation-entry-ambiguous",
          target,
          message: `${target}: expected one manifest entry but found ${matches.length}`,
        });
      }
      for (const [key] of matches) {
        if (!dynamicEntryKeys.has(key)) {
          violations.push({
            code: "navigation-entry-not-dynamic",
            target,
            message: `${target}: manifest entry ${JSON.stringify(key)} is neither flagged nor referenced as a dynamic entry`,
          });
          continue;
        }
        if (!reachableDynamicEntries.has(key)) {
          violations.push({
            code: "navigation-entry-unreachable",
            target,
            message: `${target}: dynamic manifest entry ${JSON.stringify(key)} is not reachable from the route split graph`,
          });
          continue;
        }
        for (const file of closure([key])) navigationFiles.add(file);
      }
    }
    const measurement = measureAssets(navigationFiles, assetsByFile);
    navigations[route] = measurement;
    addLimitViolations(
      violations,
      "navigation-budget",
      `navigation ${route}`,
      measurement,
      options.budgets?.navigation?.[route] ?? CLIENT_BUNDLE_BUDGETS.navigation[route],
    );
  }

  function loadingContexts(entryKey, path = new Set()) {
    if (path.has(entryKey)) return [new Set(shellFiles)];
    const parents = [
      ...new Set([...(dynamicParents.get(entryKey) ?? []), ...(staticParents.get(entryKey) ?? [])]),
    ];
    if (parents.length === 0 || clientEntryKeys.has(entryKey)) return [new Set(shellFiles)];

    const nextPath = new Set(path).add(entryKey);
    return parents.flatMap((parentKey) => {
      const parentRoute = routeEntryOwners.get(parentKey);
      const parentFiles = parentRoute
        ? new Set(routeInitialNavigations[parentRoute]?.files ?? closure([parentKey]))
        : closure([parentKey]);
      return loadingContexts(parentKey, nextPath).map(
        (context) => new Set([...context, ...parentFiles]),
      );
    });
  }

  const dynamicIncrements = [];
  for (const key of [...dynamicEntryKeys].toSorted((left, right) => left.localeCompare(right))) {
    const entry = entriesByKey.get(key);
    if (!entry) continue;
    const dynamicFiles = closure([key]);
    const parentKeys = dynamicParents.get(key) ?? [];
    const contexts = loadingContexts(key);
    const guaranteedLoadedFiles = new Set(contexts[0] ?? shellFiles);
    for (const file of guaranteedLoadedFiles) {
      if (contexts.some((context) => !context.has(file))) guaranteedLoadedFiles.delete(file);
    }
    const incrementFiles = new Set(
      [...dynamicFiles].filter((file) => !guaranteedLoadedFiles.has(file)),
    );
    const allLoadingPathsAreNested =
      parentKeys.length > 0 && parentKeys.every((parentKey) => !clientEntryKeys.has(parentKey));
    const hasParentRelativeBaseline =
      allLoadingPathsAreNested || [...guaranteedLoadedFiles].some((file) => !shellFiles.has(file));
    const parentSources = parentKeys
      .map((parentKey) => {
        const parent = entriesByKey.get(parentKey);
        return stableSource(parent ? entrySource(parentKey, parent) : parentKey);
      })
      .toSorted((left, right) => left.localeCompare(right));
    const measurement = {
      source: stableSource(entrySource(key, entry)),
      baseline: hasParentRelativeBaseline ? "parent" : "shell",
      parents: parentSources,
      ...measureAssets(incrementFiles, assetsByFile),
    };
    dynamicIncrements.push(measurement);
    addLimitViolations(
      violations,
      "dynamic-budget",
      `dynamic ${measurement.source}`,
      measurement,
      options.budgets?.dynamicIncrement ?? CLIENT_BUNDLE_BUDGETS.dynamicIncrement,
    );
  }
  dynamicIncrements.sort((left, right) => left.source.localeCompare(right.source));

  for (const { label, matches } of requiredFeatureEntries) {
    for (const [, entry] of matches) {
      for (const [route, navigation] of Object.entries(navigations)) {
        if (!navigation.files.includes(entry.file)) continue;
        if (label === "feature operational dashboard" && route === "/$projectId/dashboard")
          continue;
        violations.push({
          code: "interaction-entry-in-navigation",
          target: `${label} via ${route}`,
          message: `${label}: dynamic asset ${JSON.stringify(entry.file)} is statically reachable during navigation ${route}`,
        });
      }
    }
  }

  for (const missingImport of [...missingImports].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    violations.push({
      code: "manifest-import-missing",
      target: missingImport,
      message: `manifest import ${JSON.stringify(missingImport)} does not identify an entry`,
    });
  }
  for (const missingImport of [...missingDynamicImports].toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    violations.push({
      code: "manifest-dynamic-import-missing",
      target: missingImport,
      message: `manifest dynamic import ${JSON.stringify(missingImport)} does not identify an entry`,
    });
  }

  violations.sort(compareViolations);
  return {
    manifestPath,
    assets,
    shell,
    dynamicIncrements,
    navigations,
    violations,
  };
}

export function formatBytes(bytes) {
  return `${(bytes / 1_000).toFixed(1)} kB`;
}

function formatDiagnosticBytes(bytes) {
  return `${formatBytes(bytes)} (${bytes} B)`;
}

export function formatClientBundleReport(report) {
  if (report.violations.length > 0) {
    return [
      `[helm] Client bundle budget failed with ${report.violations.length} violation${report.violations.length === 1 ? "" : "s"}:`,
      ...report.violations.map((violation) => `- ${violation.message}`),
    ].join("\n");
  }

  const largestAsset = report.assets.toSorted((left, right) => right.rawBytes - left.rawBytes)[0];
  const largestDynamic = report.dynamicIncrements.toSorted(
    (left, right) => right.rawBytes - left.rawBytes,
  )[0];
  const navigationLines = Object.entries(report.navigations)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(
      ([route, measurement]) =>
        `- navigation ${route}: ${formatBytes(measurement.rawBytes)} raw / ${formatBytes(measurement.gzipBytes)} gzip`,
    );
  return [
    `[helm] Client bundle budgets passed (${report.assets.length} JavaScript assets).`,
    `- client shell: ${formatBytes(report.shell.rawBytes)} raw / ${formatBytes(report.shell.gzipBytes)} gzip`,
    ...navigationLines,
    ...(largestAsset
      ? [
          `- largest asset: ${largestAsset.file} (${formatBytes(largestAsset.rawBytes)} raw / ${formatBytes(largestAsset.gzipBytes)} gzip)`,
        ]
      : []),
    ...(largestDynamic
      ? [
          `- largest dynamic increment: ${largestDynamic.source} (${formatBytes(largestDynamic.rawBytes)} raw / ${formatBytes(largestDynamic.gzipBytes)} gzip)`,
        ]
      : []),
  ].join("\n");
}

export function assertClientBundleBudget(projectRoot = HELM_PROJECT_ROOT, options = {}) {
  const report = inspectClientBundle(projectRoot, options);
  const formatted = formatClientBundleReport(report);
  if (report.violations.length > 0) throw new Error(formatted);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    const report = assertClientBundleBudget();
    process.stdout.write(`${formatClientBundleReport(report)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
