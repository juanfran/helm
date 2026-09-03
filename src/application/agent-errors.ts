import { Data } from "effect";

export class InvalidAgentInputError extends Data.TaggedError("InvalidAgentInputError")<{
  readonly message: string;
}> {}

export class AgentRunRequiredError extends Data.TaggedError("AgentRunRequiredError")<{
  readonly message: string;
}> {}

export class AgentRunRegistrationError extends Data.TaggedError("AgentRunRegistrationError")<{
  readonly runId?: string;
  readonly message: string;
}> {}

export class AgentPersistenceError extends Data.TaggedError("AgentPersistenceError")<{
  readonly message: string;
}> {}

export type AgentCommandError =
  | InvalidAgentInputError
  | AgentRunRequiredError
  | AgentRunRegistrationError
  | AgentPersistenceError;

export type AgentErrorDto = {
  type: AgentCommandError["_tag"];
  message: string;
  runId?: string;
};

export function toAgentErrorDto(error: AgentCommandError): AgentErrorDto {
  if (error["_tag"] === "AgentRunRegistrationError") {
    return { type: error["_tag"], message: error.message, runId: error.runId };
  }
  return { type: error["_tag"], message: error.message };
}
