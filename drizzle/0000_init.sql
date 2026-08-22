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
CREATE TABLE `specs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`sha256` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`name`) REFERENCES `packages`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `specs_name_version_uq` ON `specs` (`name`,`version`);--> statement-breakpoint
CREATE TABLE `versions` (
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`sha256` text NOT NULL,
	`spec_id` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`package_name`, `version`),
	FOREIGN KEY (`package_name`) REFERENCES `packages`(`name`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spec_id`) REFERENCES `specs`(`id`) ON UPDATE no action ON DELETE set null
);
