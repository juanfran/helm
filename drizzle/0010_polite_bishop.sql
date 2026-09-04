CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`name` text NOT NULL,
	`definition_version` integer DEFAULT 1 NOT NULL,
	`definition_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_project_sequence_unique` ON `saved_views` (`project_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `saved_views_active_project_name_unique` ON `saved_views` (`project_id`,`name`) WHERE "saved_views"."archived_at" is null;--> statement-breakpoint
CREATE INDEX `saved_views_project_archive_sequence_index` ON `saved_views` (`project_id`,`archived_at`,`sequence`);--> statement-breakpoint
CREATE VIRTUAL TABLE `task_search` USING fts5(
	`task_id` UNINDEXED,
	`project_id` UNINDEXED,
	`title`,
	`task_content`,
	`acceptance_criteria`,
	`comments`,
	`reports`,
	tokenize = 'unicode61'
);--> statement-breakpoint
INSERT INTO `task_search` (
	`task_id`,
	`project_id`,
	`title`,
	`task_content`,
	`acceptance_criteria`,
	`comments`,
	`reports`
)
SELECT
	`task`.`id`,
	`task`.`project_id`,
	`task`.`title`,
	trim(
		coalesce(`task`.`description_text`, '') || char(10) ||
		coalesce(`task`.`expected_outcome`, '') || char(10) ||
		coalesce(`task`.`agent_context`, '') || char(10) ||
		coalesce(`task`.`checklist_json`, '')
	),
	`task`.`acceptance_criteria`,
	coalesce((
		SELECT group_concat(`entry`.`content_text`, char(10))
		FROM (
			SELECT `activity_entries`.`content_text`
			FROM `activity_entries`
			WHERE `activity_entries`.`task_id` = `task`.`id`
				AND `activity_entries`.`withdrawn_at` IS NULL
				AND `activity_entries`.`kind` <> 'system'
				AND `activity_entries`.`author_type` <> 'system'
			ORDER BY `activity_entries`.`created_at`, `activity_entries`.`id`
		) AS `entry`
	), ''),
	coalesce((
		SELECT group_concat(`report`.`searchable_text`, char(10))
		FROM (
			SELECT trim(
				coalesce(`attempts`.`summary`, '') || char(10) ||
				coalesce(`attempts`.`changed_areas_json`, '') || char(10) ||
				coalesce(`attempts`.`verification_json`, '') || char(10) ||
				coalesce(`attempts`.`references_json`, '') || char(10) ||
				coalesce(`attempts`.`risks_json`, '') || char(10) ||
				coalesce(`attempts`.`follow_up_work_json`, '') || char(10) ||
				coalesce(`attempts`.`failure_classification`, '')
			) AS `searchable_text`
			FROM `attempts`
			WHERE `attempts`.`task_id` = `task`.`id`
			ORDER BY `attempts`.`attempt_number`, `attempts`.`created_at`, `attempts`.`id`
		) AS `report`
	), '')
FROM `tasks` AS `task`;--> statement-breakpoint
CREATE TRIGGER `task_search_tasks_ai`
AFTER INSERT ON `tasks`
BEGIN
	INSERT INTO `task_search` (
		`task_id`,
		`project_id`,
		`title`,
		`task_content`,
		`acceptance_criteria`,
		`comments`,
		`reports`
	)
	VALUES (
		NEW.`id`,
		NEW.`project_id`,
		NEW.`title`,
		trim(
			coalesce(NEW.`description_text`, '') || char(10) ||
			coalesce(NEW.`expected_outcome`, '') || char(10) ||
			coalesce(NEW.`agent_context`, '') || char(10) ||
			coalesce(NEW.`checklist_json`, '')
		),
		NEW.`acceptance_criteria`,
		'',
		''
	);
END;--> statement-breakpoint
CREATE TRIGGER `task_search_tasks_au`
AFTER UPDATE OF
	`id`,
	`project_id`,
	`title`,
	`description_text`,
	`expected_outcome`,
	`agent_context`,
	`checklist_json`,
	`acceptance_criteria`
ON `tasks`
BEGIN
	UPDATE `task_search`
	SET
		`task_id` = NEW.`id`,
		`project_id` = NEW.`project_id`,
		`title` = NEW.`title`,
		`task_content` = trim(
			coalesce(NEW.`description_text`, '') || char(10) ||
			coalesce(NEW.`expected_outcome`, '') || char(10) ||
			coalesce(NEW.`agent_context`, '') || char(10) ||
			coalesce(NEW.`checklist_json`, '')
		),
		`acceptance_criteria` = NEW.`acceptance_criteria`
	WHERE `task_id` = OLD.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_tasks_ad`
AFTER DELETE ON `tasks`
BEGIN
	DELETE FROM `task_search` WHERE `task_id` = OLD.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_activity_entries_ai`
AFTER INSERT ON `activity_entries`
BEGIN
	UPDATE `task_search`
	SET `comments` = coalesce((
		SELECT group_concat(`entry`.`content_text`, char(10))
		FROM (
			SELECT `activity_entries`.`content_text`
			FROM `activity_entries`
			WHERE `activity_entries`.`task_id` = NEW.`task_id`
				AND `activity_entries`.`withdrawn_at` IS NULL
				AND `activity_entries`.`kind` <> 'system'
				AND `activity_entries`.`author_type` <> 'system'
			ORDER BY `activity_entries`.`created_at`, `activity_entries`.`id`
		) AS `entry`
	), '')
	WHERE `task_id` = NEW.`task_id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_activity_entries_au`
AFTER UPDATE OF
	`task_id`,
	`kind`,
	`author_type`,
	`content_text`,
	`withdrawn_at`
ON `activity_entries`
BEGIN
	UPDATE `task_search`
	SET `comments` = coalesce((
		SELECT group_concat(`entry`.`content_text`, char(10))
		FROM (
			SELECT `activity_entries`.`content_text`
			FROM `activity_entries`
			WHERE `activity_entries`.`task_id` = OLD.`task_id`
				AND `activity_entries`.`withdrawn_at` IS NULL
				AND `activity_entries`.`kind` <> 'system'
				AND `activity_entries`.`author_type` <> 'system'
			ORDER BY `activity_entries`.`created_at`, `activity_entries`.`id`
		) AS `entry`
	), '')
	WHERE `task_id` = OLD.`task_id`;

	UPDATE `task_search`
	SET `comments` = coalesce((
		SELECT group_concat(`entry`.`content_text`, char(10))
		FROM (
			SELECT `activity_entries`.`content_text`
			FROM `activity_entries`
			WHERE `activity_entries`.`task_id` = NEW.`task_id`
				AND `activity_entries`.`withdrawn_at` IS NULL
				AND `activity_entries`.`kind` <> 'system'
				AND `activity_entries`.`author_type` <> 'system'
			ORDER BY `activity_entries`.`created_at`, `activity_entries`.`id`
		) AS `entry`
	), '')
	WHERE `task_id` = NEW.`task_id`
		AND NEW.`task_id` <> OLD.`task_id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_activity_entries_ad`
AFTER DELETE ON `activity_entries`
BEGIN
	UPDATE `task_search`
	SET `comments` = coalesce((
		SELECT group_concat(`entry`.`content_text`, char(10))
		FROM (
			SELECT `activity_entries`.`content_text`
			FROM `activity_entries`
			WHERE `activity_entries`.`task_id` = OLD.`task_id`
				AND `activity_entries`.`withdrawn_at` IS NULL
				AND `activity_entries`.`kind` <> 'system'
				AND `activity_entries`.`author_type` <> 'system'
			ORDER BY `activity_entries`.`created_at`, `activity_entries`.`id`
		) AS `entry`
	), '')
	WHERE `task_id` = OLD.`task_id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_attempts_ai`
AFTER INSERT ON `attempts`
BEGIN
	UPDATE `task_search`
	SET `reports` = coalesce((
		SELECT group_concat(`report`.`searchable_text`, char(10))
		FROM (
			SELECT trim(
				coalesce(`attempts`.`summary`, '') || char(10) ||
				coalesce(`attempts`.`changed_areas_json`, '') || char(10) ||
				coalesce(`attempts`.`verification_json`, '') || char(10) ||
				coalesce(`attempts`.`references_json`, '') || char(10) ||
				coalesce(`attempts`.`risks_json`, '') || char(10) ||
				coalesce(`attempts`.`follow_up_work_json`, '') || char(10) ||
				coalesce(`attempts`.`failure_classification`, '')
			) AS `searchable_text`
			FROM `attempts`
			WHERE `attempts`.`task_id` = NEW.`task_id`
			ORDER BY `attempts`.`attempt_number`, `attempts`.`created_at`, `attempts`.`id`
		) AS `report`
	), '')
	WHERE `task_id` = NEW.`task_id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_attempts_au`
AFTER UPDATE OF
	`task_id`,
	`attempt_number`,
	`summary`,
	`changed_areas_json`,
	`verification_json`,
	`references_json`,
	`risks_json`,
	`follow_up_work_json`,
	`failure_classification`,
	`created_at`
ON `attempts`
BEGIN
	UPDATE `task_search`
	SET `reports` = coalesce((
		SELECT group_concat(`report`.`searchable_text`, char(10))
		FROM (
			SELECT trim(
				coalesce(`attempts`.`summary`, '') || char(10) ||
				coalesce(`attempts`.`changed_areas_json`, '') || char(10) ||
				coalesce(`attempts`.`verification_json`, '') || char(10) ||
				coalesce(`attempts`.`references_json`, '') || char(10) ||
				coalesce(`attempts`.`risks_json`, '') || char(10) ||
				coalesce(`attempts`.`follow_up_work_json`, '') || char(10) ||
				coalesce(`attempts`.`failure_classification`, '')
			) AS `searchable_text`
			FROM `attempts`
			WHERE `attempts`.`task_id` = OLD.`task_id`
			ORDER BY `attempts`.`attempt_number`, `attempts`.`created_at`, `attempts`.`id`
		) AS `report`
	), '')
	WHERE `task_id` = OLD.`task_id`;

	UPDATE `task_search`
	SET `reports` = coalesce((
		SELECT group_concat(`report`.`searchable_text`, char(10))
		FROM (
			SELECT trim(
				coalesce(`attempts`.`summary`, '') || char(10) ||
				coalesce(`attempts`.`changed_areas_json`, '') || char(10) ||
				coalesce(`attempts`.`verification_json`, '') || char(10) ||
				coalesce(`attempts`.`references_json`, '') || char(10) ||
				coalesce(`attempts`.`risks_json`, '') || char(10) ||
				coalesce(`attempts`.`follow_up_work_json`, '') || char(10) ||
				coalesce(`attempts`.`failure_classification`, '')
			) AS `searchable_text`
			FROM `attempts`
			WHERE `attempts`.`task_id` = NEW.`task_id`
			ORDER BY `attempts`.`attempt_number`, `attempts`.`created_at`, `attempts`.`id`
		) AS `report`
	), '')
	WHERE `task_id` = NEW.`task_id`
		AND NEW.`task_id` <> OLD.`task_id`;
END;--> statement-breakpoint
CREATE TRIGGER `task_search_attempts_ad`
AFTER DELETE ON `attempts`
BEGIN
	UPDATE `task_search`
	SET `reports` = coalesce((
		SELECT group_concat(`report`.`searchable_text`, char(10))
		FROM (
			SELECT trim(
				coalesce(`attempts`.`summary`, '') || char(10) ||
				coalesce(`attempts`.`changed_areas_json`, '') || char(10) ||
				coalesce(`attempts`.`verification_json`, '') || char(10) ||
				coalesce(`attempts`.`references_json`, '') || char(10) ||
				coalesce(`attempts`.`risks_json`, '') || char(10) ||
				coalesce(`attempts`.`follow_up_work_json`, '') || char(10) ||
				coalesce(`attempts`.`failure_classification`, '')
			) AS `searchable_text`
			FROM `attempts`
			WHERE `attempts`.`task_id` = OLD.`task_id`
			ORDER BY `attempts`.`attempt_number`, `attempts`.`created_at`, `attempts`.`id`
		) AS `report`
	), '')
	WHERE `task_id` = OLD.`task_id`;
END;
