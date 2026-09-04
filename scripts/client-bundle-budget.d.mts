export interface ClientBundleLimit {
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export interface ClientBundleBudgets {
  readonly shell: ClientBundleLimit;
  readonly asset: ClientBundleLimit;
  readonly dynamicIncrement: ClientBundleLimit;
  readonly navigation: Readonly<Record<string, ClientBundleLimit>>;
}

export type ClientNavigationCriticalSources = Readonly<Record<string, readonly string[]>>;

export interface ClientBundleMeasurement {
  readonly files: readonly string[];
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export interface ClientBundleAsset {
  readonly file: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
}

export interface ClientBundleDynamicIncrement extends ClientBundleMeasurement {
  readonly source: string;
  readonly baseline: "shell" | "parent";
  readonly parents: readonly string[];
}

export type ClientBundleViolationCode =
  | "asset-budget"
  | "asset-file-missing"
  | "client-entry-count"
  | "dynamic-budget"
  | "interaction-entry-in-navigation"
  | "manifest-dynamic-import-missing"
  | "manifest-import-missing"
  | "navigation-budget"
  | "navigation-entry-ambiguous"
  | "navigation-entry-missing"
  | "navigation-entry-not-dynamic"
  | "navigation-entry-unreachable"
  | "required-entry-ambiguous"
  | "required-entry-in-shell"
  | "required-entry-missing"
  | "required-entry-not-dynamic"
  | "shell-budget";

export interface ClientBundleViolation {
  readonly code: ClientBundleViolationCode;
  readonly target: string;
  readonly metric?: "rawBytes" | "gzipBytes";
  readonly actualBytes?: number;
  readonly limitBytes?: number;
  readonly message: string;
}

export interface ClientBundleReport {
  readonly manifestPath: string;
  readonly assets: readonly ClientBundleAsset[];
  readonly shell: ClientBundleMeasurement;
  readonly dynamicIncrements: readonly ClientBundleDynamicIncrement[];
  readonly navigations: Readonly<Record<string, ClientBundleMeasurement>>;
  readonly violations: readonly ClientBundleViolation[];
}

export interface InspectClientBundleOptions {
  readonly manifestPath?: string;
  readonly navigationCriticalSources?: ClientNavigationCriticalSources;
  readonly budgets?: Partial<{
    readonly shell: ClientBundleLimit;
    readonly asset: ClientBundleLimit;
    readonly dynamicIncrement: ClientBundleLimit;
    readonly navigation: Readonly<Record<string, ClientBundleLimit>>;
  }>;
}

export const CLIENT_BUNDLE_MANIFEST_PATH: string;
export const CLIENT_BUNDLE_BUDGETS: ClientBundleBudgets;
export const CLIENT_NAVIGATION_CRITICAL_SOURCES: ClientNavigationCriticalSources;
export function inspectClientBundle(
  projectRoot?: string,
  options?: InspectClientBundleOptions,
): ClientBundleReport;
export function formatBytes(bytes: number): string;
export function formatClientBundleReport(report: ClientBundleReport): string;
export function assertClientBundleBudget(
  projectRoot?: string,
  options?: InspectClientBundleOptions,
): ClientBundleReport;
