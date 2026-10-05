CREATE TABLE "personnel_employee_order_codes" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"order_code" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "personnel_employee_order_codes_tenant_id_employee_id_pk" PRIMARY KEY("tenant_id","employee_id"),
	CONSTRAINT "personnel_employee_order_codes_positive" CHECK ("personnel_employee_order_codes"."order_code" > 0 AND "personnel_employee_order_codes"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "personnel_order_rules" (
	"tenant_id" uuid NOT NULL,
	"field" text NOT NULL,
	"position" integer NOT NULL,
	"direction" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "personnel_order_rules_tenant_id_field_pk" PRIMARY KEY("tenant_id","field"),
	CONSTRAINT "personnel_order_rules_position" UNIQUE("tenant_id","position"),
	CONSTRAINT "personnel_order_rules_field" CHECK ("personnel_order_rules"."field" IN ('department','post','position','level','grade','code')),
	CONSTRAINT "personnel_order_rules_direction" CHECK ("personnel_order_rules"."direction" IN ('asc','desc')),
	CONSTRAINT "personnel_order_rules_position_valid" CHECK ("personnel_order_rules"."position" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "personnel_order_runs" (
	"tenant_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"error" text,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personnel_order_runs_tenant_id_command_id_pk" PRIMARY KEY("tenant_id","command_id"),
	CONSTRAINT "personnel_order_runs_state" CHECK ("personnel_order_runs"."state" IN ('succeeded','failed','unknown')),
	CONSTRAINT "personnel_order_runs_attempts" CHECK ("personnel_order_runs"."attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "personnel_order_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "personnel_order_settings_revision" CHECK ("personnel_order_settings"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "personnel_employee_order_codes" ADD CONSTRAINT "personnel_employee_order_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_employee_order_codes" ADD CONSTRAINT "personnel_employee_order_codes_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_order_rules" ADD CONSTRAINT "personnel_order_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_order_rules" ADD CONSTRAINT "personnel_order_rules_settings_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."personnel_order_settings"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_order_runs" ADD CONSTRAINT "personnel_order_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_order_settings" ADD CONSTRAINT "personnel_order_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personnel_employee_order_codes_order" ON "personnel_employee_order_codes" USING btree ("tenant_id","order_code","employee_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_employee_order_codes');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON personnel_employee_order_codes TO app_user;

--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_order_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON personnel_order_settings TO app_user;

--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_order_rules');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON personnel_order_rules TO app_user;

--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_order_runs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON personnel_order_runs TO app_user;
