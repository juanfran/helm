import type { ActivityEntry } from "./activity";
import type { Project } from "./projects";
import type { Task, TaskAttemptSummary } from "./tasks";

export interface PortableMarkdownInput {
  readonly project: Project;
  readonly viewName?: string | null;
  readonly tasks: readonly Task[];
  readonly attempts: readonly TaskAttemptSummary[];
  readonly entries: readonly ActivityEntry[];
}

const emptyValue = "_None._";

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function inlineLiteral(value: string) {
  return escapeHtml(value.replace(/\s+/g, " ").trim()).replace(/([\\`*_[\]{}()#+\-.!|])/g, "\\$1");
}

function blockLiteral(value: string) {
  if (value.length === 0) return emptyValue;
  const literal = escapeHtml(value)
    .replaceAll("#", "&#35;")
    .replaceAll("-", "&#45;")
    .replaceAll("+", "&#43;")
    .replaceAll("*", "&#42;")
    .replaceAll("`", "&#96;")
    .replaceAll("~", "&#126;");
  return `<pre data-helm-literal="true">\n${literal}\n</pre>`;
}

function displayValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === "") return "None";
  return inlineLiteral(String(value));
}

function sentenceLabel(value: string) {
  return value
    .split("_")
    .map((part) => (part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

function actorLabel(actor: { readonly type: string; readonly id: string } | null) {
  return actor ? `${sentenceLabel(actor.type)} ${inlineLiteral(actor.id)}` : "None";
}

function taskHeading(task: Task, level: 3 | 4 = 3) {
  return `${"#".repeat(level)} Task #${task.sequence}: ${inlineLiteral(task.title)}`;
}

function sortedTasks(tasks: readonly Task[]) {
  return [...tasks].toSorted(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}

function sortedTags(task: Task) {
  return [...task.tags].toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

function sortedCustomFields(task: Task) {
  return [...task.customFields].toSorted(
    (left, right) =>
      left.definition.position - right.definition.position ||
      left.definition.id.localeCompare(right.definition.id),
  );
}

function sortedEntries(entries: readonly ActivityEntry[]) {
  return [...entries].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function sortedAttempts(attempts: readonly TaskAttemptSummary[]) {
  return [...attempts].toSorted(
    (left, right) =>
      left.attemptNumber - right.attemptNumber ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function appendLiteralList(lines: string[], values: readonly string[]) {
  if (values.length === 0) {
    lines.push(emptyValue);
    return;
  }
  for (const value of values) lines.push(`- ${inlineLiteral(value)}`);
}

function customFieldValue(task: Task, fieldIndex: number) {
  const assignment = sortedCustomFields(task)[fieldIndex];
  if (!assignment?.value) return "Unset";
  if (assignment.value.type !== "single_select") return String(assignment.value.value);
  if (assignment.definition.type !== "single_select") return assignment.value.value;
  const option = assignment.definition.validation.options.find(
    ({ id }) => id === assignment.value?.value,
  );
  return option ? `${option.label} (${option.id})` : assignment.value.value;
}

function appendCurrentTask(lines: string[], task: Task, entries: readonly ActivityEntry[]) {
  lines.push(taskHeading(task), "", "#### Summary", "", blockLiteral(task.descriptionText), "");
  lines.push(
    "#### Outcome and acceptance",
    "",
    "##### Expected outcome",
    "",
    blockLiteral(task.expectedOutcome),
    "",
    "##### Acceptance criteria",
    "",
    blockLiteral(task.acceptanceCriteria),
    "",
    "##### Agent context",
    "",
    blockLiteral(task.agentContext),
    "",
  );

  lines.push(
    "#### Planning",
    "",
    `- Lifecycle: ${sentenceLabel(task.lifecycle)}`,
    `- Priority: ${sentenceLabel(task.priority)}`,
    `- Position: ${task.position}`,
    `- Start date: ${displayValue(task.notBefore)}`,
    `- Due date: ${displayValue(task.dueAt)}`,
    `- Size: ${displayValue(task.size)}`,
    `- Parent task ID: ${displayValue(task.parentTaskId)}`,
    `- Child task IDs: ${task.childTaskIds.length === 0 ? "None" : task.childTaskIds.map(inlineLiteral).join(", ")}`,
    `- Review override: ${displayValue(task.reviewModeOverride)}`,
    `- Effective review policy: ${displayValue(task.reviewPolicy?.mode)}`,
    `- Archived at: ${displayValue(task.archivedAt)}`,
    `- Version: ${task.version}`,
    `- Created at: ${displayValue(task.createdAt)}`,
    `- Updated at: ${displayValue(task.updatedAt)}`,
    "",
  );
  if (task.reviewPolicy) {
    lines.push(
      "##### Review-policy explanation",
      "",
      blockLiteral(task.reviewPolicy.explanation),
      "",
    );
  }

  lines.push("#### Tags", "");
  const tags = sortedTags(task);
  if (tags.length === 0) {
    lines.push(emptyValue);
  } else {
    for (const tag of tags) {
      const details = [
        tag.description,
        tag.exclusiveGroup ? `exclusive group: ${tag.exclusiveGroup}` : null,
        tag.reviewModeOverride ? `review: ${tag.reviewModeOverride}` : null,
      ].filter((value): value is string => value !== null && value.length > 0);
      lines.push(
        `- ${inlineLiteral(tag.name)} (${inlineLiteral(tag.color)})${details.length === 0 ? "" : ` — ${details.map(inlineLiteral).join("; ")}`}`,
      );
    }
  }

  lines.push("", "#### Required capabilities", "");
  appendLiteralList(
    lines,
    [...task.requiredCapabilities].toSorted((left, right) => left.localeCompare(right)),
  );

  lines.push("", "#### Referenced paths", "");
  appendLiteralList(
    lines,
    [...task.referencedPaths].toSorted((left, right) => left.localeCompare(right)),
  );

  lines.push("", "#### Custom fields", "");
  const customFields = sortedCustomFields(task);
  if (customFields.length === 0) {
    lines.push(emptyValue);
  } else {
    for (const [index, assignment] of customFields.entries()) {
      lines.push(
        `##### ${inlineLiteral(assignment.definition.display.label)} (${inlineLiteral(assignment.definition.key)})`,
        "",
        `- Type: ${sentenceLabel(assignment.definition.type)}`,
        `- Source: ${sentenceLabel(assignment.source)}`,
        `- Retired at: ${displayValue(assignment.definition.retiredAt)}`,
        "- Value:",
        "",
        blockLiteral(customFieldValue(task, index)),
        "",
      );
    }
  }

  lines.push("", "#### Checklist", "");
  if (task.checklist.length === 0) {
    lines.push(emptyValue);
  } else {
    for (const item of task.checklist) {
      lines.push(`- [${item.checked ? "x" : " "}] ${inlineLiteral(item.text)}`);
    }
  }

  lines.push("", "#### Relations", "");
  const relations = [...task.upstreamRelations, ...task.downstreamRelations].toSorted(
    (left, right) => left.id.localeCompare(right.id),
  );
  if (relations.length === 0) {
    lines.push(emptyValue);
  } else {
    for (const relation of relations) {
      lines.push(
        `- ${sentenceLabel(relation.type)}: task #${relation.sourceSequence} → task #${relation.targetSequence}`,
      );
    }
  }

  lines.push("", "#### Comments and activity", "");
  if (entries.length === 0) {
    lines.push(emptyValue);
  } else {
    for (const entry of sortedEntries(entries)) {
      lines.push(
        `##### ${sentenceLabel(entry.kind)} ${inlineLiteral(entry.id)}`,
        "",
        `- Status: ${entry.withdrawnAt ? "Withdrawn" : "Visible"}`,
        `- Author: ${inlineLiteral(entry.authorDisplayName)} (${actorLabel(entry.author)})`,
        `- Created at: ${displayValue(entry.createdAt)}`,
      );
      if (entry.attemptId) lines.push(`- Attempt ID: ${inlineLiteral(entry.attemptId)}`);
      if (entry.withdrawnAt) {
        lines.push(
          `- Withdrawn at: ${displayValue(entry.withdrawnAt)}`,
          `- Withdrawn by: ${actorLabel(entry.withdrawnBy)}`,
          "- Withdrawal reason:",
          "",
          blockLiteral(entry.withdrawalReason ?? "Not recorded"),
          "",
          "_The withdrawn entry content is intentionally omitted._",
          "",
        );
      } else {
        lines.push("- Content:", "", blockLiteral(entry.contentText), "");
      }
    }
  }
  lines.push("");
}

function attemptAttribution(attempt: TaskAttemptSummary) {
  const displayName = attempt.agentDisplayName
    ? inlineLiteral(attempt.agentDisplayName)
    : "Unattributed agent";
  const identifiers = [
    attempt.agentProfileId ? `profile ${inlineLiteral(attempt.agentProfileId)}` : null,
    attempt.agentRunId ? `run ${inlineLiteral(attempt.agentRunId)}` : null,
  ].filter((value): value is string => value !== null);
  return identifiers.length === 0 ? displayName : `${displayName} (${identifiers.join(", ")})`;
}

function appendHistoricalAttempt(lines: string[], task: Task, attempt: TaskAttemptSummary) {
  lines.push(
    `${taskHeading(task, 3)} · Attempt ${attempt.attemptNumber}`,
    "",
    `- Outcome: ${sentenceLabel(attempt.status)}`,
    `- Attribution: ${attemptAttribution(attempt)}`,
    `- Started at: ${displayValue(attempt.createdAt)}`,
    `- Completed at: ${displayValue(attempt.completedAt)}`,
    `- Failure classification: ${displayValue(attempt.failureClassification ? sentenceLabel(attempt.failureClassification) : null)}`,
    "",
    "#### Result summary",
    "",
    blockLiteral(attempt.summary),
    "",
    "#### Changed areas",
    "",
  );
  appendLiteralList(lines, attempt.changedAreas);
  lines.push("", "#### Verification", "");
  if (attempt.verificationResults.length === 0) {
    lines.push(emptyValue);
  } else {
    for (const result of attempt.verificationResults) {
      lines.push(
        `- ${inlineLiteral(result.name)} — ${sentenceLabel(result.status)}${result.details.length === 0 ? "" : ` — ${inlineLiteral(result.details)}`}`,
      );
    }
  }
  lines.push("", "#### References", "");
  appendLiteralList(lines, attempt.references);
  lines.push("", "#### Risks", "");
  appendLiteralList(lines, attempt.risks);
  lines.push("", "#### Follow-up work", "");
  appendLiteralList(lines, attempt.followUpWork);
  lines.push("");
}

export function renderPortableMarkdown(input: PortableMarkdownInput) {
  const tasks = sortedTasks(input.tasks);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const entriesByTask = new Map<string, ActivityEntry[]>();
  for (const entry of input.entries) {
    if (!taskById.has(entry.taskId)) continue;
    entriesByTask.set(entry.taskId, [...(entriesByTask.get(entry.taskId) ?? []), entry]);
  }
  const attemptsByTask = new Map<string, TaskAttemptSummary[]>();
  for (const attempt of input.attempts) {
    if (!taskById.has(attempt.taskId)) continue;
    attemptsByTask.set(attempt.taskId, [...(attemptsByTask.get(attempt.taskId) ?? []), attempt]);
  }

  const lines = [
    "# Helm Markdown export",
    "",
    "## Export scope",
    "",
    `- Project: ${inlineLiteral(input.project.name)}`,
    `- Project ID: ${inlineLiteral(input.project.id)}`,
    `- Project sequence: ${input.project.sequence}`,
    `- Repository root: ${inlineLiteral(input.project.repositoryRoot)}`,
    `- Project review policy: ${sentenceLabel(input.project.reviewMode)}`,
    `- Project version: ${input.project.version}`,
    `- Scope: ${input.viewName ? "Saved view" : "Entire project"}`,
  ];
  if (input.viewName) lines.push(`- View: ${inlineLiteral(input.viewName)}`);
  lines.push("", "## Current state", "");

  if (tasks.length === 0) {
    lines.push("_No tasks are included in this export._", "");
  } else {
    for (const task of tasks) appendCurrentTask(lines, task, entriesByTask.get(task.id) ?? []);
  }

  lines.push("## Historical attempts", "");
  let attemptCount = 0;
  for (const task of tasks) {
    for (const attempt of sortedAttempts(attemptsByTask.get(task.id) ?? [])) {
      appendHistoricalAttempt(lines, task, attempt);
      attemptCount += 1;
    }
  }
  if (attemptCount === 0) lines.push("_No historical attempts are included in this export._", "");

  return `${lines.join("\n").trimEnd()}\n`;
}
