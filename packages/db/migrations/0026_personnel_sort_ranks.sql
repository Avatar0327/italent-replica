CREATE TABLE "personnel_org_sort_ranks" (
	"tenant_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"sort_number" integer NOT NULL,
	CONSTRAINT "personnel_org_sort_ranks_tenant_id_org_id_valid_from_pk" PRIMARY KEY("tenant_id","org_id","valid_from"),
	CONSTRAINT "personnel_org_sort_ranks_range" CHECK ("personnel_org_sort_ranks"."valid_to" > "personnel_org_sort_ranks"."valid_from"),
	CONSTRAINT "personnel_org_sort_ranks_positive" CHECK ("personnel_org_sort_ranks"."sort_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "personnel_post_sort_ranks" (
	"tenant_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"sort_number" integer NOT NULL,
	CONSTRAINT "personnel_post_sort_ranks_tenant_id_post_id_valid_from_pk" PRIMARY KEY("tenant_id","post_id","valid_from"),
	CONSTRAINT "personnel_post_sort_ranks_range" CHECK ("personnel_post_sort_ranks"."valid_to" > "personnel_post_sort_ranks"."valid_from"),
	CONSTRAINT "personnel_post_sort_ranks_positive" CHECK ("personnel_post_sort_ranks"."sort_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "personnel_org_sort_ranks" ADD CONSTRAINT "personnel_org_sort_ranks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_post_sort_ranks" ADD CONSTRAINT "personnel_post_sort_ranks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personnel_org_sort_ranks_as_of" ON "personnel_org_sort_ranks" USING btree ("tenant_id","valid_from");--> statement-breakpoint
CREATE INDEX "personnel_post_sort_ranks_as_of" ON "personnel_post_sort_ranks" USING btree ("tenant_id","valid_from");