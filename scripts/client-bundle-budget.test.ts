import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ZlibOptions } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertClientBundleBudget,
  CLIENT_BUNDLE_BUDGETS,
  CLIENT_NAVIGATION_CRITICAL_SOURCES,
  formatClientBundleReport,
  inspectClientBundle,
  type ClientBundleBudgets,
  type ClientNavigationCriticalSources,
  type InspectClientBundleOptions,
} from "./client-bundle-budget.mjs";

interface ManifestEntry {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

type Manifest = Record<string, ManifestEntry>;

const temporaryDirectories: string[] = [];
const routeSources = [
  "src/routes/index.tsx",
  "src/routes/search.tsx",
  "src/routes/views.$viewId.tsx",
  "src/routes/projects.$projectId.tasks.$taskId.tsx",
] as const;
const splitProperties = ["loader", "component", "errorComponent"] as const;
const fixtureNavigationCriticalSources: ClientNavigationCriticalSources = {
  "/": ["src/features/tasks/task-workspace.tsx"],
  "/search": ["src/features/tasks/task-search-page.tsx"],
  "/views/$viewId": ["src/features/tasks/saved-view-page.tsx"],
};

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "helm-client-bundle-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path: string, content: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeFixture() {
  const root = temporaryDirectory();
  const publicRoot = join(root, ".output", "public");
  const manifestPath = join(publicRoot, ".vite", "manifest.json");
  const manifest: Manifest = {
    "_root-loader-only-J1k2L3.js": {
      file: "assets/root-loader-only-J1k2L3.js",
      imports: ["_shared-A1b2C3.js"],
    },
    "_root-shared-G7h8I9.js": {
      file: "assets/root-shared-G7h8I9.js",
      imports: ["_shared-A1b2C3.js"],
    },
    "_shared-A1b2C3.js": {
      file: "assets/shared-A1b2C3.js",
      imports: [],
    },
    "src/client.tsx": {
      file: "assets/client-D4e5F6.js",
      src: "src/client.tsx",
      isEntry: true,
      imports: ["_shared-A1b2C3.js"],
    },
  };
  const contents = new Map<string, string | Uint8Array>([
    ["assets/root-loader-only-J1k2L3.js", "export const loaderOnly = 'loader-only';\n"],
    ["assets/root-shared-G7h8I9.js", "export const rootShared = 'root-shared';\n"],
    ["assets/shared-A1b2C3.js", "export const shared = 'shared';\n"],
    ["assets/client-D4e5F6.js", "export const client = 'client';\n"],
  ]);

  for (const routeSource of routeSources) {
    for (const property of splitProperties) {
      const source = `${routeSource}?tsr-split=${property}`;
      const routeName = routeSource
        .replace("src/routes/", "")
        .replace(".tsx", "")
        .replaceAll("$", "_");
      const file = `assets/${routeName}-${property}-H4sH.js`;
      manifest[source] = {
        file,
        src: source,
        isDynamicEntry: true,
        imports: ["_shared-A1b2C3.js"],
      };
      contents.set(file, `export const split = '${source}';\n`);
    }
  }

  for (const [source, file] of [
    ["src/features/dashboard/operational-dashboard.tsx", "assets/operational-dashboard-Z9y8X7.js"],
    ["src/features/tasks/rich-text-editor.tsx", "assets/rich-text-editor-W6v5U4.js"],
  ] as const) {
    manifest[source] = {
      file,
      src: source,
      isDynamicEntry: true,
      imports: ["_shared-A1b2C3.js"],
    };
    contents.set(file, `export const feature = '${source}';\n`);
  }

  for (const [source, file] of [
    ["src/features/tasks/task-workspace.tsx", "assets/task-workspace-Q1w2E3.js"],
    ["src/features/tasks/task-search-page.tsx", "assets/task-search-page-R4t5Y6.js"],
    ["src/features/tasks/saved-view-page.tsx", "assets/saved-view-page-U7i8O9.js"],
  ] as const) {
    manifest[source] = {
      file,
      src: source,
      isDynamicEntry: true,
      imports: ["_shared-A1b2C3.js"],
    };
    contents.set(file, `export const navigationCritical = '${source}';\n`);
  }

  const clientEntry = manifest["src/client.tsx"];
  const rootComponent = manifest["src/routes/index.tsx?tsr-split=component"];
  const rootLoader = manifest["src/routes/index.tsx?tsr-split=loader"];
  const searchComponent = manifest["src/routes/search.tsx?tsr-split=component"];
  const viewComponent = manifest["src/routes/views.$viewId.tsx?tsr-split=component"];
  const workspace = manifest["src/features/tasks/task-workspace.tsx"];
  const dashboard = manifest["src/features/dashboard/operational-dashboard.tsx"];
  if (
    !clientEntry ||
    !rootComponent?.imports ||
    !rootLoader?.imports ||
    !searchComponent ||
    !viewComponent ||
    !workspace ||
    !dashboard?.imports
  ) {
    throw new Error("The complete fixture topology was not created.");
  }
  clientEntry.dynamicImports = routeSources.flatMap((routeSource) =>
    splitProperties.map((property) => `${routeSource}?tsr-split=${property}`),
  );
  rootComponent.imports.push("_root-shared-G7h8I9.js");
  rootLoader.imports.push("_root-loader-only-J1k2L3.js");
  rootComponent.dynamicImports = ["src/features/tasks/task-workspace.tsx"];
  searchComponent.dynamicImports = ["src/features/tasks/task-search-page.tsx"];
  viewComponent.dynamicImports = ["src/features/tasks/saved-view-page.tsx"];
  workspace.dynamicImports = [
    "src/features/dashboard/operational-dashboard.tsx",
    "src/features/tasks/rich-text-editor.tsx",
  ];
  dashboard.imports.push("_root-shared-G7h8I9.js", "_root-loader-only-J1k2L3.js");

  function persist() {
    write(manifestPath, `${JSON.stringify(manifest)}\n`);
    for (const [file, content] of contents) write(join(publicRoot, file), content);
  }

  persist();
  return { contents, manifest, manifestPath, persist, publicRoot, root };
}

function exactBytes(contents: Map<string, string | Uint8Array>, files: readonly string[]) {
  return files.reduce((total, file) => {
    const content = contents.get(file);
    if (content === undefined) throw new Error(`Fixture content is missing for ${file}.`);
    return total + Buffer.byteLength(content);
  }, 0);
}

function inspectFixture(
  fixture: ReturnType<typeof writeFixture>,
  options: InspectClientBundleOptions = {},
) {
  return inspectClientBundle(fixture.root, {
    ...options,
    navigationCriticalSources:
      options.navigationCriticalSources ?? fixtureNavigationCriticalSources,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("client bundle budgets", () => {
  it("pins the documented production limits", () => {
    expect(CLIENT_BUNDLE_BUDGETS).toEqual({
      shell: { rawBytes: 500_000, gzipBytes: 150_000 },
      asset: { rawBytes: 450_000, gzipBytes: 140_000 },
      dynamicIncrement: { rawBytes: 500_000, gzipBytes: 160_000 },
      navigation: {
        "/": { rawBytes: 900_000, gzipBytes: 280_000 },
        "/search": { rawBytes: 850_000, gzipBytes: 260_000 },
        "/views/$viewId": { rawBytes: 850_000, gzipBytes: 260_000 },
        "/projects/$projectId/tasks/$taskId": { rawBytes: 1_050_000, gzipBytes: 330_000 },
      },
    });
    expect(CLIENT_NAVIGATION_CRITICAL_SOURCES).toEqual({
      "/": ["src/features/projects/project-landing.tsx"],
      "/search": [],
      "/views/$viewId": [],
      "/projects/$projectId/tasks/$taskId": ["src/features/tasks/task-detail-panel.tsx"],
    });
  });

  it("walks static closures and counts shared assets once", () => {
    const fixture = writeFixture();
    const report = inspectFixture(fixture);

    expect(report.violations).toEqual([]);
    expect(report.shell.files).toEqual(["assets/client-D4e5F6.js", "assets/shared-A1b2C3.js"]);
    expect(report.shell.rawBytes).toBe(exactBytes(fixture.contents, report.shell.files));

    const rootNavigation = report.navigations["/"];
    expect(rootNavigation).toBeDefined();
    expect(rootNavigation?.files).toEqual([
      "assets/client-D4e5F6.js",
      "assets/index-component-H4sH.js",
      "assets/index-errorComponent-H4sH.js",
      "assets/index-loader-H4sH.js",
      "assets/root-loader-only-J1k2L3.js",
      "assets/root-shared-G7h8I9.js",
      "assets/shared-A1b2C3.js",
      "assets/task-workspace-Q1w2E3.js",
    ]);
    expect(rootNavigation?.rawBytes).toBe(
      exactBytes(fixture.contents, rootNavigation?.files ?? []),
    );

    const componentIncrement = report.dynamicIncrements.find(
      (increment) => increment.source === "src/routes/index.tsx?tsr-split=component",
    );
    expect(componentIncrement?.files).toEqual([
      "assets/index-component-H4sH.js",
      "assets/root-shared-G7h8I9.js",
    ]);

    const dashboardIncrement = report.dynamicIncrements.find(
      (increment) => increment.source === "src/features/dashboard/operational-dashboard.tsx",
    );
    expect(dashboardIncrement).toMatchObject({
      baseline: "parent",
      files: ["assets/operational-dashboard-Z9y8X7.js"],
      parents: ["src/features/tasks/task-workspace.tsx"],
    });
    expect(formatClientBundleReport(report)).toContain("- navigation /:");
  });

  it("measures deterministic level-nine gzip bytes", () => {
    const fixture = writeFixture();
    const report = inspectFixture(fixture);
    const clientAsset = report.assets.find((asset) => asset.file === "assets/client-D4e5F6.js");
    const clientBytes = readFileSync(join(fixture.publicRoot, "assets/client-D4e5F6.js"));

    const deterministicGzipOptions: ZlibOptions & { mtime: 0 } = { level: 9, mtime: 0 };
    expect(clientAsset?.gzipBytes).toBe(gzipSync(clientBytes, deterministicGzipOptions).byteLength);
    expect(inspectFixture(fixture).assets).toEqual(report.assets);
  });

  it("measures every manifest-referenced dynamic target when Vite omits its flag", () => {
    const fixture = writeFixture();
    const key = "_bulk-task-controls-A7b8C9.js";
    const file = "assets/bulk-task-controls-A7b8C9.js";
    const workspace = fixture.manifest["src/features/tasks/task-workspace.tsx"];
    if (!workspace?.dynamicImports) throw new Error("The fixture workspace entry is incomplete.");
    workspace.dynamicImports.push(key);
    fixture.manifest[key] = { file, imports: ["_shared-A1b2C3.js"] };
    fixture.contents.set(file, "export const bulkControls = 'intent-loaded';\n");
    fixture.persist();

    const report = inspectFixture(fixture);
    expect(report.violations).toEqual([]);
    expect(report.dynamicIncrements.find((increment) => increment.source === key)).toMatchObject({
      baseline: "parent",
      files: [file],
      parents: ["src/features/tasks/task-workspace.tsx"],
    });
  });

  it("inherits every route context through a shared static dynamic-import owner", () => {
    const fixture = writeFixture();
    const sharedOwnerKey = "_task-route-tools-launcher-S1h2A3.js";
    const sharedOwnerFile = "assets/task-route-tools-launcher-S1h2A3.js";
    const sharedDependencyKey = "_task-domain-C4o5R6.js";
    const sharedDependencyFile = "assets/task-domain-C4o5R6.js";
    const interactionSource = "src/features/tasks/task-route-results.tsx";
    const interactionFile = "assets/task-route-results-D7y8N9.js";
    const searchComponent = fixture.manifest["src/routes/search.tsx?tsr-split=component"];
    const viewComponent = fixture.manifest["src/routes/views.$viewId.tsx?tsr-split=component"];
    if (!searchComponent?.imports || !viewComponent?.imports) {
      throw new Error("The fixture route component entries are incomplete.");
    }

    searchComponent.imports.push(sharedOwnerKey);
    viewComponent.imports.push(sharedOwnerKey);
    fixture.manifest[sharedOwnerKey] = {
      file: sharedOwnerFile,
      imports: ["_shared-A1b2C3.js", sharedDependencyKey],
      dynamicImports: [interactionSource],
    };
    fixture.manifest[sharedDependencyKey] = {
      file: sharedDependencyFile,
      imports: [],
    };
    fixture.manifest[interactionSource] = {
      file: interactionFile,
      src: interactionSource,
      imports: ["_shared-A1b2C3.js", sharedDependencyKey],
    };
    fixture.contents.set(sharedOwnerFile, "export const toolsLauncher = 'shared';\n");
    fixture.contents.set(sharedDependencyFile, "export const domain = 'already loaded';\n");
    fixture.contents.set(interactionFile, "export const routeResults = 'interaction';\n");
    fixture.persist();

    const report = inspectFixture(fixture);
    const increment = report.dynamicIncrements.find(
      (candidate) => candidate.source === interactionSource,
    );

    expect(increment).toMatchObject({
      baseline: "parent",
      files: [interactionFile],
      parents: [sharedOwnerKey],
    });
    expect(report.navigations["/search"]?.files).toContain(sharedDependencyFile);
    expect(report.navigations["/views/$viewId"]?.files).toContain(sharedDependencyFile);
  });

  it("reports a manifest dynamic import whose target entry is missing", () => {
    const fixture = writeFixture();
    const missingKey = "_bulk-task-controls-missing-A7b8C9.js";
    const workspace = fixture.manifest["src/features/tasks/task-workspace.tsx"];
    if (!workspace?.dynamicImports) throw new Error("The fixture workspace entry is incomplete.");
    workspace.dynamicImports.push(missingKey);
    fixture.persist();

    expect(
      inspectFixture(fixture).violations.filter(
        (violation) => violation.code === "manifest-dynamic-import-missing",
      ),
    ).toEqual([
      {
        code: "manifest-dynamic-import-missing",
        target: missingKey,
        message: `manifest dynamic import ${JSON.stringify(missingKey)} does not identify an entry`,
      },
    ]);
  });

  it("charges multiple individually compliant automatic entries to one cumulative navigation", () => {
    const fixture = writeFixture();
    const rootComponent = fixture.manifest["src/routes/index.tsx?tsr-split=component"];
    if (!rootComponent?.dynamicImports) {
      throw new Error("The fixture root component entry is incomplete.");
    }
    const automaticSources = [
      "src/features/tasks/automatic-list.tsx",
      "src/features/tasks/automatic-summary.tsx",
    ] as const;
    for (const [index, source] of automaticSources.entries()) {
      const file = `assets/automatic-${index}.js`;
      fixture.manifest[source] = { file, src: source, imports: ["_shared-A1b2C3.js"] };
      fixture.contents.set(file, `export const payload = '${"x".repeat(200 + index)}';\n`);
      rootComponent.dynamicImports.push(source);
    }
    fixture.persist();

    const noAutomaticEntries = inspectFixture(fixture, {
      navigationCriticalSources: {},
    });
    const firstEntry = inspectFixture(fixture, {
      navigationCriticalSources: { "/": [automaticSources[0]] },
    });
    const secondEntry = inspectFixture(fixture, {
      navigationCriticalSources: { "/": [automaticSources[1]] },
    });
    const rawNavigationLimit = Math.max(
      firstEntry.navigations["/"]?.rawBytes ?? 0,
      secondEntry.navigations["/"]?.rawBytes ?? 0,
    );
    expect(rawNavigationLimit).toBeGreaterThan(noAutomaticEntries.navigations["/"]?.rawBytes ?? 0);

    const navigationCriticalSources: ClientNavigationCriticalSources = {
      "/": automaticSources,
    };
    const budgets: ClientBundleBudgets = {
      ...CLIENT_BUNDLE_BUDGETS,
      navigation: {
        ...CLIENT_BUNDLE_BUDGETS.navigation,
        "/": { rawBytes: rawNavigationLimit, gzipBytes: Number.MAX_SAFE_INTEGER },
      },
    };
    const report = inspectFixture(fixture, { budgets, navigationCriticalSources });
    const automaticSourceSet = new Set<string>(automaticSources);
    const automaticIncrements = report.dynamicIncrements.filter((increment) =>
      automaticSourceSet.has(increment.source),
    );

    expect(automaticIncrements).toHaveLength(2);
    expect(
      automaticIncrements.every(
        (increment) =>
          increment.rawBytes <= CLIENT_BUNDLE_BUDGETS.dynamicIncrement.rawBytes &&
          increment.gzipBytes <= CLIENT_BUNDLE_BUDGETS.dynamicIncrement.gzipBytes,
      ),
    ).toBe(true);
    expect(report.violations.filter((violation) => violation.code === "dynamic-budget")).toEqual(
      [],
    );
    expect(
      report.violations
        .filter((violation) => violation.code === "navigation-budget")
        .map((violation) => ({ metric: violation.metric, target: violation.target })),
    ).toEqual([{ metric: "rawBytes", target: "navigation /" }]);
    expect(report.navigations["/"]?.rawBytes).toBeGreaterThan(rawNavigationLimit);
  });

  it("reports missing, non-dynamic, and unreachable navigation-critical sources", () => {
    const fixture = writeFixture();
    const missingSource = "src/features/tasks/automatic-missing.tsx";
    const staticSource = "src/features/tasks/automatic-static.tsx";
    const unreachableSource = "src/features/tasks/automatic-unreachable.tsx";
    for (const [source, file, isDynamicEntry] of [
      [staticSource, "assets/automatic-static.js", false],
      [unreachableSource, "assets/automatic-unreachable.js", true],
    ] as const) {
      fixture.manifest[source] = { file, src: source, imports: [], isDynamicEntry };
      fixture.contents.set(file, `export const source = '${source}';\n`);
    }
    fixture.persist();

    const report = inspectFixture(fixture, {
      navigationCriticalSources: { "/": [missingSource, staticSource, unreachableSource] },
    });
    expect(
      report.violations
        .filter((violation) => violation.code.startsWith("navigation-entry-"))
        .map((violation) => ({ code: violation.code, target: violation.target })),
    ).toEqual([
      {
        code: "navigation-entry-missing",
        target: `navigation / source ${missingSource}`,
      },
      {
        code: "navigation-entry-not-dynamic",
        target: `navigation / source ${staticSource}`,
      },
      {
        code: "navigation-entry-unreachable",
        target: `navigation / source ${unreachableSource}`,
      },
    ]);
  });

  it("reports a missing emitted asset as a structured violation", () => {
    const fixture = writeFixture();
    rmSync(join(fixture.publicRoot, "assets/rich-text-editor-W6v5U4.js"));

    expect(
      inspectFixture(fixture).violations.filter(
        (violation) => violation.code === "asset-file-missing",
      ),
    ).toEqual([
      {
        code: "asset-file-missing",
        target: "assets/rich-text-editor-W6v5U4.js",
        message: 'asset "assets/rich-text-editor-W6v5U4.js": output file is missing',
      },
    ]);
  });

  it("rejects manifest assets outside the public output root", () => {
    const fixture = writeFixture();
    const clientEntry = fixture.manifest["src/client.tsx"];
    if (!clientEntry) throw new Error("The fixture client entry is missing.");
    clientEntry.file = "../outside.js";
    fixture.persist();

    expect(() => inspectFixture(fixture)).toThrow(
      'Client bundle manifest contains an unsafe asset path: "../outside.js".',
    );
  });

  it("measures a referenced target with direct and nested parents against the shell", () => {
    const fixture = writeFixture();
    const clientEntry = fixture.manifest["src/client.tsx"];
    const dashboard = fixture.manifest["src/features/dashboard/operational-dashboard.tsx"];
    if (!clientEntry?.dynamicImports) throw new Error("The fixture client entry is incomplete.");
    clientEntry.dynamicImports.push("src/features/dashboard/operational-dashboard.tsx");
    if (!dashboard) throw new Error("The fixture dashboard entry is missing.");
    delete dashboard.isDynamicEntry;
    fixture.persist();

    const dashboardIncrement = inspectFixture(fixture).dynamicIncrements.find(
      (increment) => increment.source === "src/features/dashboard/operational-dashboard.tsx",
    );
    expect(dashboardIncrement).toMatchObject({
      baseline: "shell",
      files: [
        "assets/operational-dashboard-Z9y8X7.js",
        "assets/root-loader-only-J1k2L3.js",
        "assets/root-shared-G7h8I9.js",
      ],
      parents: ["src/client.tsx", "src/features/tasks/task-workspace.tsx"],
    });
  });

  it("reports every missing required route and feature entry", () => {
    const fixture = writeFixture();
    delete fixture.manifest["src/routes/search.tsx?tsr-split=loader"];
    delete fixture.manifest["src/features/dashboard/operational-dashboard.tsx"];
    fixture.persist();

    const missing = inspectFixture(fixture).violations.filter(
      (violation) => violation.code === "required-entry-missing",
    );
    expect(missing.map((violation) => violation.target)).toEqual([
      "feature operational dashboard",
      "route /search loader",
    ]);
  });

  it("finds logical entries independently of hashed filenames and optional src metadata", () => {
    const fixture = writeFixture();
    const source = "src/routes/views.$viewId.tsx?tsr-split=component";
    const entry = fixture.manifest[source];
    if (!entry) throw new Error("The fixture view component is missing.");
    const originalFile = entry.file;
    const hashedFile = "assets/views._viewId-component-aB9_-Zz01.js";
    renameSync(join(fixture.publicRoot, originalFile), join(fixture.publicRoot, hashedFile));
    fixture.contents.set(hashedFile, fixture.contents.get(originalFile) ?? "");
    fixture.contents.delete(originalFile);
    entry.file = hashedFile;
    delete entry.src;
    fixture.persist();

    expect(inspectFixture(fixture).violations).toEqual([]);
  });

  it("rejects required split files that become statically reachable", () => {
    const fixture = writeFixture();
    const clientEntry = fixture.manifest["src/client.tsx"];
    const rootLoader = "src/routes/index.tsx?tsr-split=loader";
    const workspaceEntry = fixture.manifest["src/features/tasks/task-workspace.tsx"];
    if (!clientEntry?.imports || !workspaceEntry?.imports) {
      throw new Error("The fixture entries are missing imports.");
    }
    clientEntry.imports.push(rootLoader);
    workspaceEntry.imports.push("src/features/dashboard/operational-dashboard.tsx");
    fixture.persist();

    const report = inspectFixture(fixture);
    expect(
      report.violations
        .filter((violation) => violation.code === "required-entry-in-shell")
        .map((violation) => violation.target),
    ).toEqual(["route / loader"]);
    expect(
      report.violations
        .filter((violation) => violation.code === "interaction-entry-in-navigation")
        .map((violation) => violation.target),
    ).toEqual(["feature operational dashboard via /"]);
  });

  it("returns all limit violations in stable order", () => {
    const fixture = writeFixture();
    const tinyLimit = { rawBytes: 1, gzipBytes: 1 };
    const budgets: ClientBundleBudgets = {
      asset: tinyLimit,
      shell: tinyLimit,
      dynamicIncrement: tinyLimit,
      navigation: {
        "/": tinyLimit,
        "/search": tinyLimit,
        "/views/$viewId": tinyLimit,
      },
    };
    const report = inspectFixture(fixture, { budgets });

    expect(new Set(report.violations.map((violation) => violation.code))).toEqual(
      new Set(["asset-budget", "dynamic-budget", "navigation-budget", "shell-budget"]),
    );
    expect(report.violations.length).toBeGreaterThan(20);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      report.violations
        .map((violation) => violation.code)
        .toSorted((left, right) => left.localeCompare(right)),
    );
    expect(inspectFixture(fixture, { budgets }).violations).toEqual(report.violations);
    const firstLimitViolation = report.violations.find(
      (violation) => violation.actualBytes !== undefined,
    );
    expect(firstLimitViolation).toMatchObject({ actualBytes: expect.any(Number), limitBytes: 1 });
    expect(firstLimitViolation?.message).toMatch(
      /actual .* \(\d+ B\), limit .* \(1 B\), excess .* \(\d+ B\)/u,
    );

    const formatted = formatClientBundleReport(report);
    expect(formatted).toContain(
      `[helm] Client bundle budget failed with ${report.violations.length} violations:`,
    );
    expect(() =>
      assertClientBundleBudget(fixture.root, {
        budgets,
        navigationCriticalSources: fixtureNavigationCriticalSources,
      }),
    ).toThrow(formatted);
  });
});
