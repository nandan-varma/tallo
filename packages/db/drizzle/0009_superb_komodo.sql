CREATE TABLE `resumes` (
	`user_id` text NOT NULL,
	`job_id` integer DEFAULT 0 NOT NULL,
	`doc` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `job_id`)
);
