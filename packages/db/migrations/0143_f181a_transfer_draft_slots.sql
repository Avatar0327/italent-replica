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

--> statement-breakpoint
-- 单据离开草稿（提交 / 删除 / 审批…）即不再是暂存单：状态事件落库的同一事务里移除槽位指针，所有状态迁移入口共用
-- （撤回回到草稿的申请不会重新占槽）。放在库里而不是应用层，升级前的结构上跑的旧路径也不会去碰尚不存在的表
CREATE FUNCTION transfer_draft_slot_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'draft' THEN
    DELETE FROM transfer_draft_slots WHERE tenant_id = NEW.tenant_id AND business_id = NEW.business_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER employment_state_events_release_draft_slot AFTER INSERT ON employment_state_events
  FOR EACH ROW EXECUTE FUNCTION transfer_draft_slot_release();
