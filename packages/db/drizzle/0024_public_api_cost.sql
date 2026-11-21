CREATE INDEX `companies_lower_name_idx` ON `companies` (lower("name"));--> statement-breakpoint
CREATE INDEX `sources_last_listed_idx` ON `sources` (`last_listed_at`);