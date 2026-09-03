CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`color` text NOT NULL,
	`exclusive_group` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_project_name_unique` ON `tags` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `tags_project_group_index` ON `tags` (`project_id`,`exclusive_group`);--> statement-breakpoint
CREATE TABLE `task_capability_requirements` (
	`task_id` text NOT NULL,
	`capability` text NOT NULL,
	PRIMARY KEY(`task_id`, `capability`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_capability_requirement_index` ON `task_capability_requirements` (`capability`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`task_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `tag_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_tags_tag_index` ON `task_tags` (`tag_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `not_before` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `size` text;--> statement-breakpoint
CREATE INDEX `tasks_project_order_index` ON `tasks` (`project_id`,`archived_at`,`lifecycle`,`priority`,`position`,`due_at`,`sequence`);