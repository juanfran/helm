CREATE TABLE `custom_field_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`field_key` text NOT NULL,
	`type` text NOT NULL,
	`validation_json` text DEFAULT '{}' NOT NULL,
	`default_value_json` text,
	`display_label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_definitions_project_key_unique` ON `custom_field_definitions` (`project_id`,`field_key`);--> statement-breakpoint
CREATE INDEX `custom_field_definitions_project_position_index` ON `custom_field_definitions` (`project_id`,`retired_at`,`position`);--> statement-breakpoint
CREATE TABLE `task_custom_field_values` (
	`task_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `definition_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`definition_id`) REFERENCES `custom_field_definitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_custom_field_values_definition_index` ON `task_custom_field_values` (`definition_id`);--> statement-breakpoint
ALTER TABLE `tags` ADD `review_mode_override` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_mode_override` text;