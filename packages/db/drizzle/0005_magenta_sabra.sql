CREATE TABLE `facet_counts` (
	`facet` text NOT NULL,
	`value` text NOT NULL,
	`count` integer NOT NULL,
	`computed_at` integer NOT NULL,
	PRIMARY KEY(`facet`, `value`)
);
