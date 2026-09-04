import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PROJECT_CONTEXT_CANDIDATES,
  MAX_PROJECT_INSTRUCTION_BYTES,
  ProjectContextLimitError,
  ProjectInstructionTooLargeError,
  ProjectPathEscapeError,
  ProjectPathValidationError,
  readProjectContext,
} from "./project-instructions.server";

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix = "helm-project-instructions-") {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("readProjectContext", () => {
  it("returns only applicable instructions once in stable root-to-deep order", () => {
    const root = temporaryDirectory();
    write(join(root, "AGENTS.md"), "root");
    write(join(root, "src", "AGENTS.md"), "source");
    write(join(root, "src", "feature", "AGENTS.md"), "feature");
    write(join(root, "unrelated", "AGENTS.md"), "unrelated");
    write(join(root, "src", "feature", "existing.ts"), "export {};");

    const context = readProjectContext(root, [
      "src/feature/existing.ts",
      "src/feature",
      "src/feature/existing.ts",
    ]);

    expect(context).toEqual({
      referencedPaths: ["src/feature/existing.ts", "src/feature"],
      instructions: [
        { path: "AGENTS.md", text: "root" },
        { path: "src/AGENTS.md", text: "source" },
        { path: "src/feature/AGENTS.md", text: "feature" },
      ],
    });
  });

  it("allows missing references and applies instructions from their existing ancestors", () => {
    const root = temporaryDirectory();
    write(join(root, "AGENTS.md"), "root");
    write(join(root, "src", "AGENTS.md"), "source");

    expect(readProjectContext(root, ["src/new/missing.ts"])).toEqual({
      referencedPaths: ["src/new/missing.ts"],
      instructions: [
        { path: "AGENTS.md", text: "root" },
        { path: "src/AGENTS.md", text: "source" },
      ],
    });
  });

  it("rejects references that escape the repository lexically", () => {
    const root = temporaryDirectory();

    expect(() => readProjectContext(root, ["../outside.ts"])).toThrowError(ProjectPathEscapeError);

    try {
      readProjectContext(root, ["../outside.ts"]);
    } catch (error) {
      expect(error).toMatchObject({ reason: "lexical-escape", path: "../outside.ts" });
    }
  });

  it("rejects an existing reference reached through a symlink outside the repository", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory("helm-project-instructions-outside-");
    write(join(outside, "file.ts"), "export {};");
    symlinkSync(outside, join(root, "external"), "dir");

    expect(() => readProjectContext(root, ["external/file.ts"])).toThrowError(
      ProjectPathEscapeError,
    );

    try {
      readProjectContext(root, ["external/file.ts"]);
    } catch (error) {
      expect(error).toMatchObject({ reason: "symlink-escape", path: "external/file.ts" });
    }
  });

  it("rejects a reference below a broken symbolic link", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory("helm-project-instructions-outside-");
    symlinkSync(join(outside, "missing"), join(root, "external"), "dir");

    expect(() => readProjectContext(root, ["external/file.ts"])).toThrowError(
      ProjectPathValidationError,
    );

    try {
      readProjectContext(root, ["external/file.ts"]);
    } catch (error) {
      expect(error).toMatchObject({ reason: "broken-symlink", path: "external/file.ts" });
    }
  });

  it("rejects a missing reference below an existing file", () => {
    const root = temporaryDirectory();
    write(join(root, "file.ts"), "export {};");

    expect(() => readProjectContext(root, ["file.ts/child.ts"])).toThrowError(
      ProjectPathValidationError,
    );

    try {
      readProjectContext(root, ["file.ts/child.ts"]);
    } catch (error) {
      expect(error).toMatchObject({
        reason: "non-directory-ancestor",
        path: "file.ts/child.ts",
      });
    }
  });

  it("does not follow an applicable instruction symlink outside the repository", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory("helm-project-instructions-outside-");
    write(join(outside, "AGENTS.md"), "must not be read");
    symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));

    expect(() => readProjectContext(root, [])).toThrowError(ProjectPathEscapeError);

    try {
      readProjectContext(root, []);
    } catch (error) {
      expect(error).toMatchObject({ reason: "symlink-escape", path: "AGENTS.md" });
    }
  });

  it("rejects an oversized instruction before reading it", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "AGENTS.md"), Buffer.alloc(MAX_PROJECT_INSTRUCTION_BYTES + 1));

    expect(() => readProjectContext(root, [])).toThrowError(ProjectInstructionTooLargeError);

    try {
      readProjectContext(root, []);
    } catch (error) {
      expect(error).toMatchObject({
        path: "AGENTS.md",
        size: MAX_PROJECT_INSTRUCTION_BYTES + 1,
        maximumSize: MAX_PROJECT_INSTRUCTION_BYTES,
      });
    }
  });

  it("rejects non-portable path segments before calling the filesystem", () => {
    const root = temporaryDirectory();

    expect(() => readProjectContext(root, [`src/${"a".repeat(256)}`])).toThrowError(
      ProjectPathValidationError,
    );
    expect(() => readProjectContext(root, ["src/\0outside.ts"])).toThrowError(
      ProjectPathValidationError,
    );
  });

  it("caps aggregate instruction bytes", () => {
    const root = temporaryDirectory();
    const halfBudget = Math.floor(MAX_PROJECT_INSTRUCTION_BYTES / 2) + 1;
    write(join(root, "AGENTS.md"), "a".repeat(halfBudget));
    write(join(root, "src", "AGENTS.md"), "b".repeat(halfBudget));

    expect(() => readProjectContext(root, ["src/file.ts"])).toThrowError(ProjectContextLimitError);
  });

  it("caps instruction-path candidates from many deep references", () => {
    const root = temporaryDirectory();
    const references = Array.from(
      { length: Math.ceil(MAX_PROJECT_CONTEXT_CANDIDATES / 6) + 1 },
      (_, index) => `feature-${index}/a/b/c/d/file.ts`,
    );

    expect(() => readProjectContext(root, references)).toThrowError(ProjectContextLimitError);
  });
});
