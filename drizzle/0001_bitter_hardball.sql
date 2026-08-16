CREATE TABLE `build_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`result_version` text,
	`status` text NOT NULL,
	`invalid` integer DEFAULT false NOT NULL,
	`body` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`package_name`) REFERENCES `packages`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`name` text PRIMARY KEY NOT NULL,
	`test_url` text,
	`build_url` text,
	`repositories` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`invalid` integer DEFAULT false NOT NULL,
	`body` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`package_name`) REFERENCES `packages`(`name`) ON UPDATE no action ON DELETE cascade
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
