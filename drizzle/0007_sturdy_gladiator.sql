CREATE TABLE `activity_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text,
	`kind` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text NOT NULL,
	`author_display_name` text NOT NULL,
	`agent_profile_id` text,
	`agent_run_id` text,
	`content_json` text NOT NULL,
	`content_text` text NOT NULL,
	`created_at` text NOT NULL,
	`withdrawn_at` text,
	`withdrawn_by_type` text,
	`withdrawn_by_id` text,
	`withdrawal_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_profile_id`) REFERENCES `agent_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_entries_project_created_index` ON `activity_entries` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_entries_task_created_index` ON `activity_entries` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_entries_attempt_index` ON `activity_entries` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `manual_blockers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_by_type` text,
	`resolved_by_id` text,
	`resolved_at` text,
	`resolution` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `manual_blockers_task_status_index` ON `manual_blockers` (`task_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `manual_blockers_project_status_index` ON `manual_blockers` (`project_id`,`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `events` ADD `importance` text DEFAULT 'routine' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `changes_json` text DEFAULT '{"projectIds":[],"taskIds":[],"activityEntryIds":[],"agentRunIds":[],"scopes":[]}' NOT NULL;--> statement-breakpoint
UPDATE `events`
SET `importance` = CASE
	WHEN `kind` = 'task.attempt.failed' THEN 'critical'
	WHEN `kind` IN ('task.blocker.created', 'task.lease.expired', 'task.review.requested', 'task.entry.change_request.created') THEN 'attention'
	ELSE 'routine'
END;--> statement-breakpoint
UPDATE `events`
SET `changes_json` = json_object(
	'projectIds', CASE WHEN `project_id` IS NULL THEN json('[]') ELSE json_array(`project_id`) END,
	'taskIds', CASE
		WHEN `entity_type` = 'task' THEN json_array(`entity_id`)
		WHEN `entity_type` = 'task_relation' THEN json_array(
			json_extract(`payload_json`, '$.sourceTaskId'),
			json_extract(`payload_json`, '$.targetTaskId')
		)
		ELSE json('[]')
	END,
	'activityEntryIds', json('[]'),
	'agentRunIds', CASE WHEN `entity_type` = 'agent_run' THEN json_array(`entity_id`) ELSE json('[]') END,
	'scopes', CASE
		WHEN `entity_type` = 'project' THEN json_array('projects')
		WHEN `entity_type` IN ('task', 'task_relation') THEN json_array('tasks')
		WHEN `entity_type` = 'agent_run' THEN json_array('agents')
		WHEN `entity_type` = 'preferences' THEN json_array('preferences')
		ELSE json('[]')
	END
);
