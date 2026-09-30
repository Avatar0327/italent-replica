CREATE TABLE `hris_assignment_requests` (
	`tenant_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`position_id` text,
	`grade_id` text,
	PRIMARY KEY(`tenant_id`, `approval_id`),
	FOREIGN KEY (`tenant_id`,`approval_id`) REFERENCES `hris_approvals`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`position_id`) REFERENCES `hris_positions`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`grade_id`) REFERENCES `hris_grades`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hris_employee_positions` (
	`tenant_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`position_id` text,
	`grade_id` text,
	PRIMARY KEY(`tenant_id`, `employee_id`),
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `hris_employees`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`position_id`) REFERENCES `hris_positions`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`grade_id`) REFERENCES `hris_grades`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hris_grades` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_grade_code` ON `hris_grades` (`tenant_id`,`code`);--> statement-breakpoint
CREATE TABLE `hris_positions` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`org_id` text NOT NULL,
	`family` text NOT NULL,
	`responsibilities` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`org_id`) REFERENCES `hris_orgs`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_position_code` ON `hris_positions` (`tenant_id`,`code`);