CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`title` text NOT NULL,
	`lifecycle` text NOT NULL,
	`description_json` text NOT NULL,
	`description_text` text NOT NULL,
	`expected_outcome` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`agent_context` text NOT NULL,
	`checklist_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_sequence_unique` ON `tasks` (`project_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `tasks_project_queue_index` ON `tasks` (`project_id`,`archived_at`,`lifecycle`);