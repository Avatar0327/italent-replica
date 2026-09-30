CREATE TABLE `hris_access_grants` (
	`email` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`employee_id` text,
	`active` integer DEFAULT 1 NOT NULL,
	`claimed_by` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hris_installation` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
