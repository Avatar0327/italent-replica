CREATE TABLE "transfer_completion_todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"field_code" text NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "transfer_completion_todos_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfer_completion_todos_field" CHECK ("transfer_completion_todos"."field_code" LIKE 'preset:%')
);
--> statement-breakpoint
ALTER TABLE "transfer_completion_todos" ADD CONSTRAINT "transfer_completion_todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_completion_todos" ADD CONSTRAINT "transfer_completion_todos_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_completion_todos_open_field" ON "transfer_completion_todos" USING btree ("tenant_id","employee_id","field_code") WHERE "transfer_completion_todos"."closed_at" IS NULL;