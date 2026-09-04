import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    sequence: integer("sequence").notNull(),
    name: text("name").notNull(),
    repositoryRoot: text("repository_root").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_sequence_unique").on(table.sequence),
    uniqueIndex("projects_repository_root_unique").on(table.repositoryRoot),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sequence: integer("sequence").notNull(),
    parentTaskId: text("parent_task_id").references((): AnySQLiteColumn => tasks.id),
    title: text("title").notNull(),
    lifecycle: text("lifecycle", { enum: ["backlog", "ready", "done", "cancelled"] }).notNull(),
    priority: text("priority", { enum: ["urgent", "high", "normal", "low"] })
      .notNull()
      .default("normal"),
    position: integer("position").notNull().default(0),
    notBefore: text("not_before"),
    dueAt: text("due_at"),
    size: text("size", { enum: ["xs", "s", "m", "l", "xl"] }),
    descriptionJson: text("description_json").notNull(),
    descriptionText: text("description_text").notNull(),
    expectedOutcome: text("expected_outcome").notNull(),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    agentContext: text("agent_context").notNull(),
    checklistJson: text("checklist_json").notNull(),
    version: integer("version").notNull().default(1),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tasks_project_sequence_unique").on(table.projectId, table.sequence),
    index("tasks_project_queue_index").on(table.projectId, table.archivedAt, table.lifecycle),
    index("tasks_parent_index").on(table.parentTaskId),
    index("tasks_project_order_index").on(
      table.projectId,
      table.archivedAt,
      table.lifecycle,
      table.priority,
      table.position,
      table.dueAt,
      table.sequence,
    ),
  ],
);

export const taskRelations = sqliteTable(
  "task_relations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    sourceTaskId: text("source_task_id")
      .notNull()
      .references(() => tasks.id),
    targetTaskId: text("target_task_id")
      .notNull()
      .references(() => tasks.id),
    type: text("type", {
      enum: ["blocks", "related_to", "duplicates", "discovered_from"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("task_relations_unique").on(table.sourceTaskId, table.targetTaskId, table.type),
    index("task_relations_source_index").on(table.sourceTaskId),
    index("task_relations_target_index").on(table.targetTaskId),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    name: text("name").notNull(),
    description: text("description").notNull(),
    color: text("color").notNull(),
    exclusiveGroup: text("exclusive_group"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("tags_project_name_unique").on(table.projectId, table.name),
    index("tags_project_group_index").on(table.projectId, table.exclusiveGroup),
  ],
);

export const taskTags = sqliteTable(
  "task_tags",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.tagId] }),
    index("task_tags_tag_index").on(table.tagId),
  ],
);

export const taskCapabilityRequirements = sqliteTable(
  "task_capability_requirements",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    capability: text("capability").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.capability] }),
    index("task_capability_requirement_index").on(table.capability),
  ],
);

export const taskReferencedPaths = sqliteTable(
  "task_referenced_paths",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    path: text("path").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.path] }),
    index("task_referenced_paths_path_index").on(table.path),
  ],
);

export const agentProfiles = sqliteTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    profileKey: text("profile_key").notNull(),
    displayName: text("display_name").notNull(),
    capabilitiesJson: text("capabilities_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("agent_profiles_profile_key_unique").on(table.profileKey)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => agentProfiles.id),
    mcpSessionId: text("mcp_session_id").notNull(),
    status: text("status", { enum: ["active", "closed"] }).notNull(),
    clientName: text("client_name"),
    clientVersion: text("client_version"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => [
    uniqueIndex("agent_runs_mcp_session_unique").on(table.mcpSessionId),
    index("agent_runs_profile_index").on(table.profileId),
  ],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    agentRunId: text("agent_run_id").references(() => agentRuns.id),
    status: text("status", { enum: ["active", "completed", "failed", "abandoned"] }).notNull(),
    summary: text("summary").notNull(),
    verificationJson: text("verification_json").notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [index("attempts_task_index").on(table.taskId, table.createdAt)],
);

export const preferences = sqliteTable("preferences", {
  id: integer("id").primaryKey(),
  activeProjectId: text("active_project_id").references(() => projects.id),
  theme: text("theme", { enum: ["light", "dark", "system"] })
    .notNull()
    .default("system"),
  updatedAt: text("updated_at").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    cursor: integer("cursor").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").references(() => projects.id),
    kind: text("kind").notNull(),
    actorType: text("actor_type", { enum: ["human", "agent", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("events_project_cursor_index").on(table.projectId, table.cursor)],
);

export const idempotencyRecords = sqliteTable("idempotency_records", {
  key: text("key").primaryKey(),
  command: text("command").notNull(),
  inputHash: text("input_hash").notNull(),
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const schema = {
  projects,
  tasks,
  tags,
  taskTags,
  taskCapabilityRequirements,
  taskReferencedPaths,
  agentProfiles,
  agentRuns,
  attempts,
  taskRelations,
  preferences,
  events,
  idempotencyRecords,
};
