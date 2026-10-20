CREATE TABLE "retirement_intentions" (
	"id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"department_id" uuid,
	"intended_date" date NOT NULL,
	"expected_date_snapshot" date,
	"earliest_snapshot" date,
	"latest_snapshot" date,
	"reason" text,
	"initiator" text NOT NULL,
	"initiator_user_id" uuid NOT NULL,
	"state" text NOT NULL,
	"approval_instance_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retirement_intentions_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "retirement_intentions_initiator" CHECK ("retirement_intentions"."initiator" IN ('hr', 'self')),
	CONSTRAINT "retirement_intentions_state" CHECK ("retirement_intentions"."state" IN ('draft', 'in_review', 'rejected', 'approved', 'disapproved', 'withdrawn')),
	CONSTRAINT "retirement_intentions_reason" CHECK ("retirement_intentions"."reason" IS NULL OR char_length("retirement_intentions"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "approval_instances" DROP CONSTRAINT "approval_instances_business_type";--> statement-breakpoint
CREATE INDEX "retirement_intentions_employee" ON "retirement_intentions" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retirement_intentions_open" ON "retirement_intentions" USING btree ("tenant_id","employee_id") WHERE "retirement_intentions"."state" IN ('draft', 'in_review', 'rejected');--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_business_type" CHECK ("approval_instances"."business_type" IN ('employment','personnel_change','contract','idp','talent_review','part_time',
        'offer','offer_batch','probation_assessment','retirement_intention'));--> statement-breakpoint
-- R2-T04 BE-5d2（设计 §2.5）：租户隔离与授权。业务表不给 DELETE；创建后只有意向日期、原因、快照三项、状态、审批实例、
-- revision 可变，员工、任职周期、部门快照、发起人冻结。
SELECT enable_tenant_isolation('retirement_intentions');
--> statement-breakpoint
GRANT SELECT, INSERT ON retirement_intentions TO app_user;
--> statement-breakpoint
GRANT UPDATE (intended_date, expected_date_snapshot, earliest_snapshot, latest_snapshot, reason, state,
  approval_instance_id, revision, command_id, updated_at) ON retirement_intentions TO app_user;
