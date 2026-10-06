CREATE TABLE "transfer_establishment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"capacity_id" uuid NOT NULL,
	"position_id" uuid,
	"local_delta" integer NOT NULL,
	"inclusive_delta" integer NOT NULL,
	"reserved_local_delta" integer NOT NULL,
	"reserved_inclusive_delta" integer NOT NULL,
	"reversed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_establishment_allocations_unit" CHECK ("transfer_establishment_allocations"."local_delta" BETWEEN -1 AND 1
      AND "transfer_establishment_allocations"."inclusive_delta" BETWEEN -1 AND 1 AND "transfer_establishment_allocations"."reserved_local_delta" BETWEEN -1 AND 1
      AND "transfer_establishment_allocations"."reserved_inclusive_delta" BETWEEN -1 AND 1)
);
--> statement-breakpoint
ALTER TABLE "transfer_requests" ADD COLUMN "with_establishment" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_establishment_allocations" ADD CONSTRAINT "transfer_establishment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_establishment_allocations" ADD CONSTRAINT "transfer_establishment_allocations_business_fk" FOREIGN KEY ("tenant_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_establishment_allocations" ADD CONSTRAINT "transfer_establishment_allocations_capacity_fk" FOREIGN KEY ("tenant_id","capacity_id") REFERENCES "public"."establishment_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;