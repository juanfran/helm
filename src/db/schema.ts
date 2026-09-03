import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    title: text("title").notNull(),
    lifecycle: text("lifecycle", { enum: ["backlog", "ready"] }).notNull(),
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
  ],
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

export const schema = { projects, tasks, preferences, events, idempotencyRecords };
