CREATE TABLE `hris_approval_steps` (
	`tenant_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`position` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`decision` text,
	`at` text,
	PRIMARY KEY(`tenant_id`, `approval_id`, `position`),
	FOREIGN KEY (`tenant_id`,`approval_id`) REFERENCES `hris_approvals`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_step_assignee` ON `hris_approval_steps` (`tenant_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `hris_approvals` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`employee_id` text NOT NULL,
	`kind` text NOT NULL,
	`org_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`created` text NOT NULL,
	`created_by` text,
	`decided` text,
	`decided_by` text,
	`current_step` integer,
	`workflow_version` integer,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `hris_employees`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`org_id`) REFERENCES `hris_orgs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_approval_status` ON `hris_approvals` (`tenant_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pending_employee` ON `hris_approvals` (`tenant_id`,`employee_id`) WHERE "hris_approvals"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `hris_employees` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`org_id` text NOT NULL,
	`job` text NOT NULL,
	`level` text NOT NULL,
	`joined` text NOT NULL,
	`status` text NOT NULL,
	`email` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`org_id`) REFERENCES `hris_orgs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_employee_code` ON `hris_employees` (`tenant_id`,`code`);--> statement-breakpoint
CREATE INDEX `idx_employee_org` ON `hris_employees` (`tenant_id`,`org_id`);--> statement-breakpoint
CREATE TABLE `hris_employment_history` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`employee_id` text NOT NULL,
	`event_id` text NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`from_org_id` text,
	`to_org_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`job` text NOT NULL,
	`level` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `hris_employees`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_history_employee` ON `hris_employment_history` (`tenant_id`,`employee_id`,`at`);--> statement-breakpoint
CREATE TABLE `hris_orgs` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`city` text NOT NULL,
	`leader` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`parent_id`) REFERENCES `hris_orgs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_org_parent` ON `hris_orgs` (`tenant_id`,`parent_id`);--> statement-breakpoint
CREATE TABLE `hris_workflow_steps` (
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`position` integer NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `kind`, `version`, `position`),
	FOREIGN KEY (`tenant_id`,`kind`,`version`) REFERENCES `hris_workflows`(`tenant_id`,`kind`,`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hris_workflows` (
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `kind`, `version`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `hris_access_grants` ADD `org_scope` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `hris_access_grants` ADD `view_email` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hris_access_grants` ADD `view_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hris_memberships` ADD `org_scope` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `hris_memberships` ADD `view_email` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hris_memberships` ADD `view_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hris_workspaces` ADD `storage_version` integer DEFAULT 0 NOT NULL;