ALTER TABLE `attempts` ADD `agent_profile_id` text REFERENCES agent_profiles(id);--> statement-breakpoint
ALTER TABLE `attempts` ADD `agent_display_name` text;--> statement-breakpoint
UPDATE `attempts`
SET `agent_profile_id` = (
  SELECT `agent_runs`.`profile_id`
  FROM `agent_runs`
  WHERE `agent_runs`.`id` = `attempts`.`agent_run_id`
)
WHERE `agent_run_id` IS NOT NULL;--> statement-breakpoint
UPDATE `attempts`
SET `agent_display_name` = (
  SELECT `agent_profiles`.`display_name`
  FROM `agent_profiles`
  WHERE `agent_profiles`.`id` = `attempts`.`agent_profile_id`
)
WHERE `agent_profile_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `changed_areas_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `references_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `risks_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `follow_up_work_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `attempts` ADD `failure_classification` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `review_mode` text DEFAULT 'required' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_attempt_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cancelled_from_lifecycle` text;
