-- F-474-7b 职务职级图谱：每租户一份当前快照 + 待确认记录（派生缓存，设计 §3）
CREATE TABLE "job_graph_snapshots" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"generated_by" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"contains_error" boolean NOT NULL,
	"empty" boolean NOT NULL,
	"issue_count" integer NOT NULL,
	"layout" jsonb NOT NULL,
	CONSTRAINT "job_graph_snapshots_revision_positive" CHECK ("job_graph_snapshots"."revision" > 0),
	CONSTRAINT "job_graph_snapshots_issue_count" CHECK ("job_graph_snapshots"."issue_count" >= 0),
	CONSTRAINT "job_graph_layout_object" CHECK (jsonb_typeof("job_graph_snapshots"."layout") = 'object')
);
--> statement-breakpoint
CREATE TABLE "job_graph_issues" (
	"tenant_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"object_id" uuid NOT NULL,
	"object_name" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"sort_key" integer NOT NULL,
	CONSTRAINT "job_graph_issues_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "job_graph_issues_kind" CHECK ("job_graph_issues"."kind" IN ('level','post')),
	CONSTRAINT "job_graph_issues_reasons_array" CHECK (jsonb_typeof("job_graph_issues"."reasons") = 'array' AND jsonb_array_length("job_graph_issues"."reasons") > 0)
);
--> statement-breakpoint
ALTER TABLE "job_graph_snapshots" ADD CONSTRAINT "job_graph_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_graph_snapshots" ADD CONSTRAINT "job_graph_snapshots_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_graph_issues" ADD CONSTRAINT "job_graph_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_graph_issues_tenant_kind" ON "job_graph_issues" USING btree ("tenant_id","kind","sort_key");--> statement-breakpoint
-- 租户隔离（FORCE RLS）：快照只增改不删；待确认记录是缓存，重新生成时先删后插，所以多授 DELETE
SELECT enable_tenant_isolation('job_graph_snapshots');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_graph_issues');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON job_graph_snapshots TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON job_graph_issues TO app_user;
