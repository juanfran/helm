ALTER TABLE `preferences` ADD `active_project_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `preferences`
SET `active_project_version` = 1
WHERE `active_project_id` IS NOT NULL;--> statement-breakpoint
UPDATE `idempotency_records`
SET `result_json` = json_set(
  `result_json`,
  '$.activeProjectVersion',
  CASE
    WHEN json_type(`result_json`, '$.activeProject') = 'object' THEN 1
    ELSE 0
  END
)
WHERE `command` = 'preference.theme.set'
  AND json_type(`result_json`, '$.activeProjectVersion') IS NULL;
