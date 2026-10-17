CREATE TABLE "transfer_draft_slots" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_draft_slots_tenant_id_user_id_employee_id_pk" PRIMARY KEY("tenant_id","user_id","employee_id"),
	CONSTRAINT "transfer_draft_slots_business" UNIQUE("tenant_id","business_id")
);
--> statement-breakpoint
ALTER TABLE "transfer_draft_slots" ADD CONSTRAINT "transfer_draft_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_draft_slots" ADD CONSTRAINT "transfer_draft_slots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_draft_slots" ADD CONSTRAINT "transfer_draft_slots_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- F-181a：暂存单槽位是可覆盖 / 可清除的“当前指针”（不是业务事实），开放 INSERT / UPDATE / DELETE；业务单据与审计仍只追加
SELECT enable_tenant_isolation('transfer_draft_slots');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON transfer_draft_slots TO app_user;
