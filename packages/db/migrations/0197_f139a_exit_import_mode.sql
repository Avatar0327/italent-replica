-- F-139a 历史离职人员导入：离职单模式新增 import（设计 §5）。
-- 约束只放宽取值；exit_requests_direct_by_hr 仍只约束 direct，import 的发起人由导入服务固定为 hr。
ALTER TABLE "exit_requests" DROP CONSTRAINT "exit_requests_mode";
--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_mode" CHECK ("exit_requests"."mode" IN ('application', 'direct', 'import'));
