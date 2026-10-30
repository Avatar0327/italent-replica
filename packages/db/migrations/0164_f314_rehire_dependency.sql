CREATE TABLE "retire_rehire_dependencies" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"retirement_id" uuid NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "retire_rehire_dependencies_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "retire_rehire_dependencies_distinct" CHECK ("retire_rehire_dependencies"."business_id" <> "retire_rehire_dependencies"."retirement_id")
);
--> statement-breakpoint
ALTER TABLE "retire_rehire_dependencies" ADD CONSTRAINT "retire_rehire_dependencies_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retire_rehire_dependencies" ADD CONSTRAINT "retire_rehire_dependencies_retirement_fk" FOREIGN KEY ("tenant_id","employee_id","retirement_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retire_rehire_dependencies_retirement" ON "retire_rehire_dependencies" USING btree ("tenant_id","employee_id","retirement_id");
--> statement-breakpoint
-- DEC-677：关联是退休返聘的内部扩展，行级租户隔离；更换关联与作废均由原任职命令写审计。
SELECT enable_tenant_isolation('retire_rehire_dependencies');
--> statement-breakpoint
GRANT SELECT, INSERT ON retire_rehire_dependencies TO app_user;
--> statement-breakpoint
GRANT UPDATE (retirement_id, invalidated_at) ON retire_rehire_dependencies TO app_user;
