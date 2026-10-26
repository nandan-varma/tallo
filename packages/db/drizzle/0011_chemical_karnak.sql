CREATE TABLE `applications` (
	`user_id` text NOT NULL,
	`job_id` integer NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text,
	`apply_url` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`applied_at` integer,
	PRIMARY KEY(`user_id`, `job_id`)
);
