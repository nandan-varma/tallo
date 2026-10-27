DROP INDEX `jobs_feed_idx`;--> statement-breakpoint
DROP INDEX `jobs_company_idx`;--> statement-breakpoint
CREATE INDEX `jobs_feed_idx` ON `jobs` ("sort_at" desc,"id" desc) WHERE "jobs"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_slug`,"sort_at" desc) WHERE "jobs"."closed_at" IS NULL;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `is_us`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `is_tech`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `classifier_version`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `salary_min_annual`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `salary_max_annual`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `salary_currency`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `exp_min_years`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `exp_max_years`;--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `hidden`;