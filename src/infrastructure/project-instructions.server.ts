import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export const MAX_PROJECT_INSTRUCTION_BYTES = 256 * 1024;
export const MAX_PROJECT_INSTRUCTION_FILES = 32;
export const MAX_PROJECT_CONTEXT_CANDIDATES = 512;

export type ProjectPathEscapeReason = "absolute-reference" | "lexical-escape" | "symlink-escape";

export class ProjectPathEscapeError extends Error {
  readonly name = "ProjectPathEscapeError";
  readonly _tag = "ProjectPathEscapeError";

  constructor(
    readonly path: string,
    readonly repositoryRoot: string,
    readonly reason: ProjectPathEscapeReason,
  ) {
    super(`Project path "${path}" is outside repository root "${repositoryRoot}".`);
  }
}

export class ProjectInstructionTooLargeError extends Error {
  readonly name = "ProjectInstructionTooLargeError";
  readonly _tag = "ProjectInstructionTooLargeError";

  constructor(
    readonly path: string,
    readonly size: number,
    readonly maximumSize: number = MAX_PROJECT_INSTRUCTION_BYTES,
  ) {
    super(`Project instruction "${path}" is ${size} bytes; the limit is ${maximumSize} bytes.`);
  }
}

export class ProjectPathValidationError extends Error {
  readonly name = "ProjectPathValidationError";
  readonly _tag = "ProjectPathValidationError";

  constructor(
    readonly path: string,
    readonly reason:
      | "not-normalized"
      | "segment-too-long"
      | "control-character"
      | "broken-symlink"
      | "non-directory-ancestor",
  ) {
    super(
      reason === "segment-too-long"
        ? `Project path "${path}" has a segment longer than 255 UTF-8 bytes.`
        : reason === "control-character"
          ? `Project path "${path}" contains a control character.`
          : reason === "broken-symlink"
            ? `Project path "${path}" contains a broken symbolic link.`
            : reason === "non-directory-ancestor"
              ? `Project path "${path}" continues below a non-directory entry.`
              : `Project path "${path}" is not a normalized repository-relative path.`,
    );
  }
}

export class ProjectContextLimitError extends Error {
  readonly name = "ProjectContextLimitError";
  readonly _tag = "ProjectContextLimitError";

  constructor(
    readonly path: string,
    readonly resource: "instruction-bytes" | "instruction-files" | "path-candidates",
    readonly actual: number,
    readonly maximum: number,
  ) {
    super(`Project context exceeds the ${resource} limit (${actual} > ${maximum}) at "${path}".`);
  }
}

export interface ProjectInstruction {
  path: string;
  text: string;
}

export interface ProjectContext {
  referencedPaths: string[];
  instructions: ProjectInstruction[];
}

interface NormalizedReference {
  absolutePath: string;
  relativePath: string;
}

interface InstructionCandidate {
  absolutePath: string;
  relativePath: string;
  depth: number;
}

interface ResolvedInstruction {
  path: string;
  canonicalPath: string;
  size: number;
}

function isInsideRepository(repositoryRoot: string, path: string) {
  const relativePath = relative(repositoryRoot, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function portablePath(path: string) {
  return path.split(sep).join("/");
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function normalizeReference(canonicalRoot: string, reference: string): NormalizedReference {
  if (isAbsolute(reference) || win32.isAbsolute(reference)) {
    throw new ProjectPathEscapeError(reference, canonicalRoot, "absolute-reference");
  }

  const absolutePath = resolve(canonicalRoot, reference);
  if (!isInsideRepository(canonicalRoot, absolutePath)) {
    throw new ProjectPathEscapeError(reference, canonicalRoot, "lexical-escape");
  }

  const segments = reference.split(/[\\/]/);
  if (
    reference.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new ProjectPathValidationError(reference, "not-normalized");
  }
  if (hasControlCharacter(reference)) {
    throw new ProjectPathValidationError(reference, "control-character");
  }
  if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > 255)) {
    throw new ProjectPathValidationError(reference, "segment-too-long");
  }

  const relativePath = relative(canonicalRoot, absolutePath);
  return {
    absolutePath,
    relativePath: relativePath === "" ? "." : portablePath(relativePath),
  };
}

function assertExistingPathInsideRepository(canonicalRoot: string, reference: NormalizedReference) {
  let existingPath = reference.absolutePath;
  let hasMissingDescendant = false;

  while (existingPath !== canonicalRoot) {
    let entry: Stats;
    try {
      entry = lstatSync(existingPath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      hasMissingDescendant = true;
      existingPath = dirname(existingPath);
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(existingPath);
    } catch (error) {
      if (isMissingPathError(error) && entry.isSymbolicLink()) {
        throw new ProjectPathValidationError(reference.relativePath, "broken-symlink");
      }
      throw error;
    }
    if (!isInsideRepository(canonicalRoot, canonicalPath)) {
      throw new ProjectPathEscapeError(reference.relativePath, canonicalRoot, "symlink-escape");
    }
    if (hasMissingDescendant && !statSync(canonicalPath).isDirectory()) {
      throw new ProjectPathValidationError(reference.relativePath, "non-directory-ancestor");
    }
    return;
  }
}

function resolveProjectReferences(repositoryRoot: string, referencedPaths: readonly string[]) {
  const canonicalRoot = realpathSync(repositoryRoot);
  const normalizedReferences = new Map<string, NormalizedReference>();

  for (const referencedPath of referencedPaths) {
    const reference = normalizeReference(canonicalRoot, referencedPath);
    assertExistingPathInsideRepository(canonicalRoot, reference);
    if (!normalizedReferences.has(reference.absolutePath)) {
      normalizedReferences.set(reference.absolutePath, reference);
    }
  }

  return { canonicalRoot, normalizedReferences };
}

/**
 * Validates that task references are normalized and that every existing path
 * component still resolves inside the repository. Missing in-repository paths
 * remain valid so a task may reference work that has not been created yet.
 */
export function validateProjectReferencedPaths(
  repositoryRoot: string,
  referencedPaths: readonly string[],
) {
  const { normalizedReferences } = resolveProjectReferences(repositoryRoot, referencedPaths);
  return [...normalizedReferences.values()].map(({ relativePath }) => relativePath);
}

function instructionStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

function resolveInstruction(
  canonicalRoot: string,
  candidate: InstructionCandidate,
): ResolvedInstruction | undefined {
  if (!instructionStat(candidate.absolutePath)) return undefined;

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate.absolutePath);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }

  if (!isInsideRepository(canonicalRoot, canonicalPath)) {
    throw new ProjectPathEscapeError(candidate.relativePath, canonicalRoot, "symlink-escape");
  }

  const file = statSync(canonicalPath);
  if (!file.isFile()) return undefined;
  if (file.size > MAX_PROJECT_INSTRUCTION_BYTES) {
    throw new ProjectInstructionTooLargeError(candidate.relativePath, file.size);
  }

  return {
    path: candidate.relativePath,
    canonicalPath,
    size: file.size,
  };
}

function compareCandidates(left: InstructionCandidate, right: InstructionCandidate) {
  if (left.depth !== right.depth) return left.depth - right.depth;
  if (left.relativePath < right.relativePath) return -1;
  if (left.relativePath > right.relativePath) return 1;
  return 0;
}

/**
 * Reads the AGENTS.md files that apply to repository-relative task paths.
 *
 * Returned paths stay repository-relative. References may point at files,
 * directories, or not-yet-created paths, but may never escape the repository.
 */
export function readProjectContext(
  repositoryRoot: string,
  referencedPaths: readonly string[],
): ProjectContext {
  const { canonicalRoot, normalizedReferences } = resolveProjectReferences(
    repositoryRoot,
    referencedPaths,
  );

  const candidates = new Map<string, InstructionCandidate>();
  const addCandidate = (directory: string, depth: number) => {
    const absolutePath = join(directory, "AGENTS.md");
    if (candidates.has(absolutePath)) return;
    const relativePath = relative(canonicalRoot, absolutePath);
    if (candidates.size >= MAX_PROJECT_CONTEXT_CANDIDATES) {
      throw new ProjectContextLimitError(
        portablePath(relativePath),
        "path-candidates",
        candidates.size + 1,
        MAX_PROJECT_CONTEXT_CANDIDATES,
      );
    }
    candidates.set(absolutePath, {
      absolutePath,
      relativePath: portablePath(relativePath),
      depth,
    });
  };

  addCandidate(canonicalRoot, 0);
  for (const reference of normalizedReferences.values()) {
    if (reference.relativePath === ".") continue;

    let directory = canonicalRoot;
    for (const [index, segment] of reference.relativePath.split("/").entries()) {
      directory = join(directory, segment);
      addCandidate(directory, index + 1);
    }
  }

  const instructions: ProjectInstruction[] = [];
  const canonicalInstructions = new Set<string>();
  let instructionBytes = 0;
  for (const candidate of [...candidates.values()].toSorted(compareCandidates)) {
    const instruction = resolveInstruction(canonicalRoot, candidate);
    if (!instruction || canonicalInstructions.has(instruction.canonicalPath)) continue;
    if (instructions.length >= MAX_PROJECT_INSTRUCTION_FILES) {
      throw new ProjectContextLimitError(
        instruction.path,
        "instruction-files",
        instructions.length + 1,
        MAX_PROJECT_INSTRUCTION_FILES,
      );
    }
    instructionBytes += instruction.size;
    if (instructionBytes > MAX_PROJECT_INSTRUCTION_BYTES) {
      throw new ProjectContextLimitError(
        instruction.path,
        "instruction-bytes",
        instructionBytes,
        MAX_PROJECT_INSTRUCTION_BYTES,
      );
    }
    canonicalInstructions.add(instruction.canonicalPath);
    instructions.push({
      path: instruction.path,
      text: readFileSync(instruction.canonicalPath, "utf8"),
    });
  }

  return {
    referencedPaths: [...normalizedReferences.values()].map(({ relativePath }) => relativePath),
    instructions,
  };
}
