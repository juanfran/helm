CREATE TABLE `task_referenced_paths` (
	`task_id` text NOT NULL,
	`path` text NOT NULL,
	PRIMARY KEY(`task_id`, `path`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_referenced_paths_path_index` ON `task_referenced_paths` (`path`);
--> statement-breakpoint
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
	'task.tags.repaired',
	'system',
	'helm-migration-0005',
	'task',
	`task_tags`.`task_id`,
	json_object(
		'exclusiveGroup', `tags`.`exclusive_group`,
		'assignedTags', json_group_array(`tags`.`name` ORDER BY `tags`.`name`),
		'retainedTag', min(`tags`.`name`),
		'policy', 'keep_lexicographically_first'
	),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `task_tags`
INNER JOIN `tags` ON `tags`.`id` = `task_tags`.`tag_id`
INNER JOIN `tasks` ON `tasks`.`id` = `task_tags`.`task_id`
WHERE `tags`.`exclusive_group` IS NOT NULL
GROUP BY `task_tags`.`task_id`, `tags`.`exclusive_group`
HAVING count(*) > 1;
--> statement-breakpoint
UPDATE `tasks`
SET
	`version` = `version` + 1,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `id` IN (
	SELECT `task_tags`.`task_id`
	FROM `task_tags`
	INNER JOIN `tags` ON `tags`.`id` = `task_tags`.`tag_id`
	WHERE `tags`.`exclusive_group` IS NOT NULL
	GROUP BY `task_tags`.`task_id`, `tags`.`exclusive_group`
	HAVING count(*) > 1
);
--> statement-breakpoint
DELETE FROM `task_tags`
WHERE EXISTS (
	SELECT 1
	FROM `tags` AS `assigned_tag`
	INNER JOIN `task_tags` AS `other_assignment`
		ON `other_assignment`.`task_id` = `task_tags`.`task_id`
	INNER JOIN `tags` AS `other_tag`
		ON `other_tag`.`id` = `other_assignment`.`tag_id`
	WHERE `assigned_tag`.`id` = `task_tags`.`tag_id`
		AND `assigned_tag`.`exclusive_group` IS NOT NULL
		AND `other_tag`.`exclusive_group` = `assigned_tag`.`exclusive_group`
		AND `other_tag`.`name` < `assigned_tag`.`name`
);
--> statement-breakpoint
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
	`project_id`,
	'task.dates.repaired',
	'system',
	'helm-migration-0005',
	'task',
	`id`,
	json_object('notBefore', `not_before`, 'dueAt', `due_at`),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `tasks`
WHERE
	(`not_before` IS NOT NULL AND (date(`not_before`, '+0 days') IS NULL OR date(`not_before`, '+0 days') <> `not_before`))
	OR (`due_at` IS NOT NULL AND (date(`due_at`, '+0 days') IS NULL OR date(`due_at`, '+0 days') <> `due_at`));
--> statement-breakpoint
UPDATE `idempotency_records`
SET `result_json` = json_remove(
	json_set(
		`result_json`,
		'$.notBefore',
		CASE
			WHEN json_extract(`result_json`, '$.notBefore') IS NOT NULL
				AND (
					date(json_extract(`result_json`, '$.notBefore'), '+0 days') IS NULL
					OR date(json_extract(`result_json`, '$.notBefore'), '+0 days') <> json_extract(`result_json`, '$.notBefore')
				)
			THEN NULL
			ELSE json_extract(`result_json`, '$.notBefore')
		END,
		'$.dueAt',
		CASE
			WHEN json_extract(`result_json`, '$.dueAt') IS NOT NULL
				AND (
					date(json_extract(`result_json`, '$.dueAt'), '+0 days') IS NULL
					OR date(json_extract(`result_json`, '$.dueAt'), '+0 days') <> json_extract(`result_json`, '$.dueAt')
				)
			THEN NULL
			ELSE json_extract(`result_json`, '$.dueAt')
		END
	),
	'$.eligibility'
)
WHERE `command` IN (
	'task.create',
	'task.prepare',
	'task.planning.update',
	'task.complete',
	'task.reopen',
	'task.archive'
)
AND (
	(
		json_extract(`result_json`, '$.notBefore') IS NOT NULL
		AND (
			date(json_extract(`result_json`, '$.notBefore'), '+0 days') IS NULL
			OR date(json_extract(`result_json`, '$.notBefore'), '+0 days') <> json_extract(`result_json`, '$.notBefore')
		)
	)
	OR (
		json_extract(`result_json`, '$.dueAt') IS NOT NULL
		AND (
			date(json_extract(`result_json`, '$.dueAt'), '+0 days') IS NULL
			OR date(json_extract(`result_json`, '$.dueAt'), '+0 days') <> json_extract(`result_json`, '$.dueAt')
		)
	)
);
--> statement-breakpoint
UPDATE `tasks`
SET
	`not_before` = CASE
		WHEN `not_before` IS NOT NULL AND (date(`not_before`, '+0 days') IS NULL OR date(`not_before`, '+0 days') <> `not_before`)
		THEN NULL
		ELSE `not_before`
	END,
	`due_at` = CASE
		WHEN `due_at` IS NOT NULL AND (date(`due_at`, '+0 days') IS NULL OR date(`due_at`, '+0 days') <> `due_at`)
		THEN NULL
		ELSE `due_at`
	END,
	`version` = `version` + 1,
	`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE
	(`not_before` IS NOT NULL AND (date(`not_before`, '+0 days') IS NULL OR date(`not_before`, '+0 days') <> `not_before`))
	OR (`due_at` IS NOT NULL AND (date(`due_at`, '+0 days') IS NULL OR date(`due_at`, '+0 days') <> `due_at`));
