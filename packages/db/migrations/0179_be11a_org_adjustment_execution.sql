CREATE TABLE "org_adjustment_executions" (
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"run_on_date" date NOT NULL,
	"run_from_hour" smallint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "org_adjustment_executions_tenant_id_adjustment_id_pk" PRIMARY KEY("tenant_id","adjustment_id"),
	CONSTRAINT "org_adjustment_executions_hour" CHECK ("org_adjustment_executions"."run_from_hour" IN (0, 3)),
	CONSTRAINT "org_adjustment_executions_state" CHECK ("org_adjustment_executions"."state" IN ('pending', 'running', 'done'))
);
--> statement-breakpoint
CREATE TABLE "org_adjustment_group_attempts" (
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"group_item_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_adjustment_group_attempts_tenant_id_adjustment_id_group_item_id_pk" PRIMARY KEY("tenant_id","adjustment_id","group_item_id"),
	CONSTRAINT "org_adjustment_attempts_positive" CHECK ("org_adjustment_group_attempts"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "org_adjustment_pauses" (
	"tenant_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	CONSTRAINT "org_adjustment_pauses_tenant_id_org_id_pk" PRIMARY KEY("tenant_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "org_adjustment_scope_orgs" (
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"group_item_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "org_adjustment_scope_orgs_tenant_id_adjustment_id_group_item_id_org_id_pk" PRIMARY KEY("tenant_id","adjustment_id","group_item_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "org_adjustment_tenant_runners" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"holder_token" text,
	"fencing_no" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"current_adjustment_id" uuid
);
--> statement-breakpoint
ALTER TABLE "org_adjustment_executions" ADD CONSTRAINT "org_adjustment_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_executions" ADD CONSTRAINT "org_adjustment_executions_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_group_attempts" ADD CONSTRAINT "org_adjustment_group_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_group_attempts" ADD CONSTRAINT "org_adjustment_attempts_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_pauses" ADD CONSTRAINT "org_adjustment_pauses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_pauses" ADD CONSTRAINT "org_adjustment_pauses_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_scope_orgs" ADD CONSTRAINT "org_adjustment_scope_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_scope_orgs" ADD CONSTRAINT "org_adjustment_scope_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_tenant_runners" ADD CONSTRAINT "org_adjustment_tenant_runners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_tenant_runners" ADD CONSTRAINT "org_adjustment_runners_current_fk" FOREIGN KEY ("tenant_id","current_adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_adjustment_executions_state" ON "org_adjustment_executions" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "org_adjustment_pauses_adjustment" ON "org_adjustment_pauses" USING btree ("tenant_id","adjustment_id");--> statement-breakpoint
CREATE INDEX "org_adjustment_scope_org" ON "org_adjustment_scope_orgs" USING btree ("tenant_id","org_id");--> statement-breakpoint
-- R2-T08 §2.3 / §7：执行五表同租户隔离（硬规则 7），执行器与暂停判定都在 withTenant 内读写。
SELECT enable_tenant_isolation('org_adjustment_scope_orgs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_scope_orgs TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('org_adjustment_executions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_executions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('org_adjustment_tenant_runners');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_tenant_runners TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('org_adjustment_pauses');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_pauses TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('org_adjustment_group_attempts');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_group_attempts TO app_user;
