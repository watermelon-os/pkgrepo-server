CREATE TABLE `packages` (
	`name` text PRIMARY KEY NOT NULL,
	`repositories` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`name` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`package_name`, `version`),
	FOREIGN KEY (`package_name`) REFERENCES `packages`(`name`) ON UPDATE no action ON DELETE cascade
);
