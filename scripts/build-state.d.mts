export type ProductionBuildStatus =
  | "current"
  | "missing-output"
  | "missing-manifest"
  | "invalid-manifest"
  | "inputs-changed";

export function computeBuildFingerprint(projectRoot?: string): string;
export function productionBuildStatus(projectRoot?: string): ProductionBuildStatus;
export function buildProduction(projectRoot?: string): Promise<void>;
export function ensureProductionBuild(projectRoot?: string): Promise<boolean>;
