CREATE TABLE "survey360_sheet_timings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"relation_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"page_started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "survey360_sheet_timings_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_sheet_timings_pair" UNIQUE("relation_id","questionnaire_id")
);
--> statement-breakpoint
ALTER TABLE "survey360_sheet_timings" ADD CONSTRAINT "survey360_sheet_timings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sheet_timings" ADD CONSTRAINT "survey360_sheet_timings_relation_fk" FOREIGN KEY ("tenant_id","relation_id") REFERENCES "public"."survey360_relations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sheet_timings" ADD CONSTRAINT "survey360_sheet_timings_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;