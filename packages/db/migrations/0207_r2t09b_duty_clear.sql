-- R2-T09b：职责转交强校验 / 指定日期 / 未转交清空（DT-R3 / DT-R5）。
-- ① exit_requests 增加指定日期列与 specified_date 时机；② 转交记录表允许离职 / 退休落地清空的系统记录（来源 2 / 4：
-- 清空时没有接收人和操作人、未完成；补转交后在原记录上补接收人 / 操作人并转已完成，DEC-863②）；③ 菜单“一人一职责至多一条待生效”唯一索引只约束菜单记录。
-- 占位序号 0209（0205～0208 被在途 PR 预留），合并时由 pnpm merge:main 顺延。
ALTER TABLE "duty_transfer_records" DROP CONSTRAINT "duty_transfer_records_source";--> statement-breakpoint
ALTER TABLE "exit_requests" DROP CONSTRAINT "exit_requests_timing";--> statement-breakpoint
DROP INDEX "duty_transfer_records_one_pending";--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ALTER COLUMN "receiver_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ALTER COLUMN "operator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD COLUMN "duty_transfer_date" date;--> statement-breakpoint
CREATE UNIQUE INDEX "duty_transfer_records_one_pending" ON "duty_transfer_records" USING btree ("tenant_id","employee_id",COALESCE("org_id", "subordinate_id"),COALESCE("org_role", "relation")) WHERE "duty_transfer_records"."status" = 0 AND "duty_transfer_records"."source" = 1;--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_party" CHECK (("duty_transfer_records"."source" = 1 AND "duty_transfer_records"."receiver_id" IS NOT NULL AND "duty_transfer_records"."operator_id" IS NOT NULL)
        OR ("duty_transfer_records"."source" IN (2, 4) AND "duty_transfer_records"."receiver_id" IS NULL AND "duty_transfer_records"."status" = 0)
        OR ("duty_transfer_records"."source" IN (2, 4) AND "duty_transfer_records"."receiver_id" IS NOT NULL AND "duty_transfer_records"."operator_id" IS NOT NULL AND "duty_transfer_records"."status" = 1));--> statement-breakpoint
ALTER TABLE "duty_transfer_records" ADD CONSTRAINT "duty_transfer_records_source" CHECK ("duty_transfer_records"."source" IN (1, 2, 4));--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_timing_date" CHECK (("exit_requests"."duty_transfer_timing" = 'specified_date') = ("exit_requests"."duty_transfer_date" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_timing" CHECK ("exit_requests"."duty_transfer_timing" IN ('business_effective', 'approval_passed', 'specified_date'));--> statement-breakpoint
-- 转交时机 / 指定日期随离职表单修改（尚未转交前，DT-R3）：exit_requests 对应用角色只开放列级 UPDATE
GRANT UPDATE (duty_transfer_timing, duty_transfer_date) ON exit_requests TO app_user;
