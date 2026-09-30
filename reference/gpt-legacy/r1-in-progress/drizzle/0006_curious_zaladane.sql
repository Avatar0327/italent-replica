CREATE TABLE `hris_attachments` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`employee_id` text,
	`record_id` text,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `hris_employees`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`record_id`) REFERENCES `hris_development_records`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attachment_key` ON `hris_attachments` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_attachment_employee` ON `hris_attachments` (`tenant_id`,`employee_id`);--> statement-breakpoint
CREATE TABLE `hris_development_records` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`employee_id` text,
	`position_id` text,
	`reference_id` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `hris_workspaces`(`owner`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`employee_id`) REFERENCES `hris_employees`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`position_id`) REFERENCES `hris_positions`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`,`reference_id`) REFERENCES `hris_development_records`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_development_kind` ON `hris_development_records` (`tenant_id`,`kind`,`status`);--> statement-breakpoint
CREATE INDEX `idx_development_employee` ON `hris_development_records` (`tenant_id`,`employee_id`,`kind`);