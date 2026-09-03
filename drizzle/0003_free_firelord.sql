CREATE TABLE `task_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_task_id` text NOT NULL,
	`target_task_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_relations_unique` ON `task_relations` (`source_task_id`,`target_task_id`,`type`);--> statement-breakpoint
CREATE INDEX `task_relations_source_index` ON `task_relations` (`source_task_id`);--> statement-breakpoint
CREATE INDEX `task_relations_target_index` ON `task_relations` (`target_task_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_task_id` text REFERENCES tasks(id);--> statement-breakpoint
CREATE INDEX `tasks_parent_index` ON `tasks` (`parent_task_id`);