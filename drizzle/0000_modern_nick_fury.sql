CREATE TABLE `events` (
	`cursor` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_project_cursor_index` ON `events` (`project_id`,`cursor`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`key` text PRIMARY KEY NOT NULL,
	`command` text NOT NULL,
	`input_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_project_id` text,
	`theme` text DEFAULT 'system' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`active_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`sequence` integer NOT NULL,
	`name` text NOT NULL,
	`repository_root` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_sequence_unique` ON `projects` (`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_root_unique` ON `projects` (`repository_root`);