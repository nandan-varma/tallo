ALTER TABLE `sources` ADD `next_due_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `tier` text DEFAULT 'rare' NOT NULL;--> statement-breakpoint
CREATE INDEX `sources_next_due_idx` ON `sources` (`next_due_at`);