CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_key` text NOT NULL,
	`display_name` text NOT NULL,
	`capabilities_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profiles_profile_key_unique` ON `agent_profiles` (`profile_key`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`mcp_session_id` text NOT NULL,
	`status` text NOT NULL,
	`client_name` text,
	`client_version` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`profile_id`) REFERENCES `agent_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_mcp_session_unique` ON `agent_runs` (`mcp_session_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_profile_index` ON `agent_runs` (`profile_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_run_id` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`verification_json` text NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attempts_task_index` ON `attempts` (`task_id`,`created_at`);