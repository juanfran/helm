import { createServerFn } from "@tanstack/react-start";

import {
  compiledExecuteProjectImportInputSchema,
  compiledPreviewProjectImportInputSchema,
} from "../domain/portability";
import { executePortableProjectImport, executePreviewProjectImport } from "./portability-adapter";
import { portabilityServices } from "./project-runtime.server";

const LOCAL_HUMAN = { type: "human", id: "local-human" } as const;

export const previewHumanProjectImport = createServerFn({ method: "POST" })
  .validator(compiledPreviewProjectImportInputSchema)
  .handler(({ data }) => executePreviewProjectImport(data, LOCAL_HUMAN, portabilityServices));

export const executeHumanProjectImport = createServerFn({ method: "POST" })
  .validator(compiledExecuteProjectImportInputSchema)
  .handler(({ data }) => executePortableProjectImport(data, LOCAL_HUMAN, portabilityServices));
