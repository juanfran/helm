CREATE TABLE `leases` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`agent_run_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`acquired_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`invalidated_at` text,
	`invalidation_reason` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leases_token_hash_unique` ON `leases` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `leases_one_active_per_task` ON `leases` (`task_id`) WHERE "leases"."status" = 'active';--> statement-breakpoint
CREATE INDEX `leases_agent_run_status_index` ON `leases` (`agent_run_id`,`status`);--> statement-breakpoint
CREATE INDEX `leases_status_expiry_index` ON `leases` (`status`,`expires_at`);--> statement-breakpoint
INSERT INTO `events` (
	`project_id`,
	`kind`,
	`actor_type`,
	`actor_id`,
	`entity_type`,
	`entity_id`,
	`payload_json`,
	`occurred_at`
)
SELECT
	`tasks`.`project_id`,
	'task.attempts.reconciled',
	'system',
	'helm-migration-0006',
	'task',
	`attempts`.`task_id`,
	json_object(
		'abandonedAttempts', count(*),
		'reason', 'pre-lease active attempts cannot own work'
	),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `attempts`
INNER JOIN `tasks` ON `tasks`.`id` = `attempts`.`task_id`
WHERE `attempts`.`status` = 'active'
GROUP BY `attempts`.`task_id`;--> statement-breakpoint
UPDATE `attempts`
SET
	`status` = 'abandoned',
	`summary` = CASE
		WHEN `summary` = '' THEN 'Reconciled during lease migration.'
		ELSE `summary`
	END,
	`completed_at` = coalesce(`completed_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE `status` = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_one_active_per_task` ON `attempts` (`task_id`) WHERE "attempts"."status" = 'active';
