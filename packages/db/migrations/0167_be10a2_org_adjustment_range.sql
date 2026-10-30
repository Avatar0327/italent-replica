CREATE TABLE "org_adjustment_range_orgs" (
	"tenant_id" uuid NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "org_adjustment_range_orgs_tenant_id_adjustment_id_org_id_pk" PRIMARY KEY("tenant_id","adjustment_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "org_adjustments" DROP CONSTRAINT "org_adjustments_scope_note";--> statement-breakpoint
ALTER TABLE "org_adjustment_range_orgs" ADD CONSTRAINT "org_adjustment_range_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_range_orgs" ADD CONSTRAINT "org_adjustment_range_adjustment_fk" FOREIGN KEY ("tenant_id","adjustment_id") REFERENCES "public"."org_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_adjustment_range_orgs" ADD CONSTRAINT "org_adjustment_range_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_adjustment_range_org" ON "org_adjustment_range_orgs" USING btree ("tenant_id","org_id");--> statement-breakpoint
ALTER TABLE "org_adjustments" DROP COLUMN "scope_note";--> statement-breakpoint
-- R2-T08 §2.1A：范围子表同租户隔离；旧 scope_note 直接删除，不迁数据（DEC-402）。
SELECT enable_tenant_isolation('org_adjustment_range_orgs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_adjustment_range_orgs TO app_user;
