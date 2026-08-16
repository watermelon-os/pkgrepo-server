CREATE TABLE `repositories` (
	`name` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL
);
