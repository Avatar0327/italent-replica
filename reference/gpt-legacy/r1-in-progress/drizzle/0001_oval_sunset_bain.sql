CREATE TABLE `hris_audit_events` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`subject` text NOT NULL,
	`at` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hris_memberships` (
	`user_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`employee_id` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `hris_workspaces` ADD `last_mutation` text DEFAULT '' NOT NULL;