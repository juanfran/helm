import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { listProjectCustomization } from "../application/customizations";
import {
  compiledAddCustomFieldDefinitionInputSchema,
  compiledListProjectCustomizationInputSchema,
  compiledReorderCustomFieldDefinitionsInputSchema,
  compiledRetireCustomFieldDefinitionInputSchema,
  compiledSetTagReviewModeOverrideInputSchema,
} from "../domain/customization";
import {
  executeAddCustomFieldDefinition,
  executeChangeTagReviewModeOverride,
  executeReorderCustomFieldDefinitions,
  executeRetireCustomFieldDefinition,
} from "./customization-adapter";
import { customizationServices } from "./project-runtime.server";

const LOCAL_HUMAN = { type: "human", id: "local-human" } as const;

export const readProjectCustomization = createServerFn({ method: "GET" })
  .validator(compiledListProjectCustomizationInputSchema)
  .handler(({ data }) => Effect.runPromise(listProjectCustomization(data, customizationServices)));

export const addHumanCustomFieldDefinition = createServerFn({ method: "POST" })
  .validator(compiledAddCustomFieldDefinitionInputSchema)
  .handler(({ data }) => executeAddCustomFieldDefinition(data, LOCAL_HUMAN, customizationServices));

export const retireHumanCustomFieldDefinition = createServerFn({ method: "POST" })
  .validator(compiledRetireCustomFieldDefinitionInputSchema)
  .handler(({ data }) =>
    executeRetireCustomFieldDefinition(data, LOCAL_HUMAN, customizationServices),
  );

export const reorderHumanCustomFieldDefinitions = createServerFn({ method: "POST" })
  .validator(compiledReorderCustomFieldDefinitionsInputSchema)
  .handler(({ data }) =>
    executeReorderCustomFieldDefinitions(data, LOCAL_HUMAN, customizationServices),
  );

export const changeHumanTagReviewModeOverride = createServerFn({ method: "POST" })
  .validator(compiledSetTagReviewModeOverrideInputSchema)
  .handler(({ data }) =>
    executeChangeTagReviewModeOverride(data, LOCAL_HUMAN, customizationServices),
  );
