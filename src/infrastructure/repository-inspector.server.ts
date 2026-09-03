import { access, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { Effect } from "effect";

import type { RepositoryInspector } from "../application/projects";
import { InvalidRepositoryRootError } from "../application/project-errors";

export const localRepositoryInspector: RepositoryInspector = {
  inspect(inputPath) {
    const requestedPath = inputPath.trim();

    return Effect.tryPromise({
      try: async () => {
        let canonicalRoot: string;
        try {
          canonicalRoot = await realpath(requestedPath);
        } catch {
          throw new InvalidRepositoryRootError({
            path: requestedPath,
            reason: "missing",
            message: "That repository path does not exist.",
          });
        }

        const rootStat = await stat(canonicalRoot);
        if (!rootStat.isDirectory()) {
          throw new InvalidRepositoryRootError({
            path: requestedPath,
            reason: "not-directory",
            message: "A repository root must be a directory.",
          });
        }

        try {
          await access(join(canonicalRoot, ".git"));
        } catch {
          throw new InvalidRepositoryRootError({
            path: requestedPath,
            reason: "not-repository-root",
            message: "The directory is not a repository root (no .git entry was found).",
          });
        }

        return { canonicalRoot, name: basename(canonicalRoot) };
      },
      catch: (error) => {
        if (error instanceof InvalidRepositoryRootError) return error;
        return new InvalidRepositoryRootError({
          path: requestedPath,
          reason: "missing",
          message: "The repository path could not be inspected.",
        });
      },
    });
  },
};
