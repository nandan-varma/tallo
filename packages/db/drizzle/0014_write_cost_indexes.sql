DROP INDEX `jobs_feed_idx`;--> statement-breakpoint
DROP INDEX `jobs_company_idx`;--> statement-breakpoint
CREATE INDEX `jobs_jd_hash_idx` ON `jobs` (`jd_hash`);--> statement-breakpoint
CREATE INDEX `jobs_closed_idx` ON `jobs` (`closed_at`) WHERE "jobs"."closed_at" IS NOT NULL;