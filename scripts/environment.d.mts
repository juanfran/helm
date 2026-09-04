export const HELM_PROJECT_ROOT: string;
export const DEFAULT_DATABASE_URL: string;
export const DEFAULT_HOST: string;

export type EnvironmentValues = Record<string, string | undefined>;

export function loadHelmEnvironment(options?: {
  cwd?: string;
  processEnv?: EnvironmentValues;
}): EnvironmentValues;

export function resolveHelmEnvironment(processEnv?: EnvironmentValues): {
  databaseUrl: string;
  host: string;
};
export function databaseUrlFromEnvironment(processEnv?: EnvironmentValues): string;
export function serverHostFromEnvironment(processEnv?: EnvironmentValues): string;

export function databaseFilePath(databaseUrl: string, cwd?: string): string | null;
export function ensureDatabaseParent(databaseUrl: string, cwd?: string): string | null;
