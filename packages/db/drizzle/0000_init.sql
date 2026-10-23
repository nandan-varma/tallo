CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`posting_id` text NOT NULL,
	`company` text NOT NULL,
	`company_slug` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`apply_url` text,
	`location_text` text,
	`city` text,
	`region` text,
	`country_code` text,
	`work_mode` text,
	`is_us` integer,
	`is_tech` integer,
	`classifier_version` integer NOT NULL,
	`department` text,
	`team` text,
	`employment_type` text,
	`requisition_id` text,
	`posted_at` integer,
	`source_updated_at` integer,
	`expires_at` integer,
	`salary_min_annual` real,
	`salary_max_annual` real,
	`salary_currency` text,
	`exp_min_years` real,
	`exp_max_years` real,
	`excerpt` text NOT NULL,
	`jd_hash` text NOT NULL,
	`jd_bytes` integer NOT NULL,
	`source_hash` text NOT NULL,
	`facts` text NOT NULL,
	`sort_at` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`absent_runs` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`hidden` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_source_posting_idx` ON `jobs` (`source_id`,`posting_id`);--> statement-breakpoint
CREATE INDEX `jobs_feed_idx` ON `jobs` ("sort_at" desc,"id" desc) WHERE "jobs"."closed_at" IS NULL AND "jobs"."hidden" = 0;--> statement-breakpoint
CREATE INDEX `jobs_company_idx` ON `jobs` (`company_slug`,"sort_at" desc) WHERE "jobs"."closed_at" IS NULL AND "jobs"."hidden" = 0;--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`runner_id` text NOT NULL,
	`collector_version` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`requests` integer,
	`seen` integer,
	`added` integer DEFAULT 0 NOT NULL,
	`changed` integer DEFAULT 0 NOT NULL,
	`closed` integer,
	`reopened` integer,
	`raw_key` text,
	`issues` text
);
--> statement-breakpoint
CREATE INDEX `runs_source_idx` ON `runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`key` text NOT NULL,
	`company` text NOT NULL,
	`company_slug` text NOT NULL,
	`params` text NOT NULL,
	`last_run_at` integer,
	`last_complete_run_at` integer,
	`last_status` text
);
