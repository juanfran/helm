import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { listAgentRuns } from "../application/agents";
import { compiledListAgentRunsInputSchema } from "../domain/agents";
import { agentServices } from "./project-runtime.server";

export const readAgentRuns = createServerFn({ method: "GET" })
  .validator(compiledListAgentRunsInputSchema)
  .handler(({ data }) => Effect.runPromise(listAgentRuns(data, agentServices)));
