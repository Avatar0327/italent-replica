CREATE TABLE `hris_development_events` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`record_id` text NOT NULL,
	`revision` integer NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`at` text NOT NULL,
	`snapshot` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `id`),
	FOREIGN KEY (`tenant_id`,`record_id`) REFERENCES `hris_development_records`(`tenant_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_development_events` ON `hris_development_events` (`tenant_id`,`record_id`,`revision`);