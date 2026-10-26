ALTER TABLE `sources` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `status` text DEFAULT 'active' NOT NULL;