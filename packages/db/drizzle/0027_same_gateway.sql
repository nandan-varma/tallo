CREATE TABLE `site_snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`computed_at` integer NOT NULL,
	`catalog_at` integer NOT NULL,
	`body` text NOT NULL
);
