ALTER TABLE `jobs` ADD `dedupe_key` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dup_of` integer;--> statement-breakpoint
CREATE INDEX `jobs_dedupe_idx` ON `jobs` (`dedupe_key`) WHERE "jobs"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `jobs_dup_of_idx` ON `jobs` (`dup_of`) WHERE "jobs"."dup_of" IS NOT NULL;