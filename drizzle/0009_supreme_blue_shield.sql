ALTER TABLE `attempts` ADD `attempt_number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `attempts`
SET `attempt_number` = (
  SELECT `ranked`.`attempt_number`
  FROM (
    SELECT
      `id`,
      row_number() OVER (
        PARTITION BY `task_id`
        ORDER BY `created_at`, `rowid`
      ) AS `attempt_number`
    FROM `attempts`
  ) AS `ranked`
  WHERE `ranked`.`id` = `attempts`.`id`
);--> statement-breakpoint
UPDATE `idempotency_records`
SET `result_json` = json_set(
  `result_json`,
  '$.attempt.attemptNumber',
  (
    SELECT `attempts`.`attempt_number`
    FROM `attempts`
    WHERE `attempts`.`id` = json_extract(`idempotency_records`.`result_json`, '$.attempt.id')
  )
)
WHERE json_type(`result_json`, '$.attempt.id') = 'text'
  AND EXISTS (
    SELECT 1
    FROM `attempts`
    WHERE `attempts`.`id` = json_extract(`idempotency_records`.`result_json`, '$.attempt.id')
  );--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_task_number_unique` ON `attempts` (`task_id`,`attempt_number`);
