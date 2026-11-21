CREATE TABLE `companies` (
	`slug` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `title_tokens` (
	`token` text PRIMARY KEY NOT NULL
);
