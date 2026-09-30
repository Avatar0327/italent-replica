-- 手写迁移：PG 16 基线特性演示（docs/07_M0/02_技术栈评估.md §6「数据库」「版本链」）。
-- 同一租户、同一对象的有效期不得重叠；日后任职记录的“生效”版本沿用同一写法。
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "m0_demo_validity"
  ADD CONSTRAINT "m0_demo_validity_no_overlap"
  EXCLUDE USING gist ("tenant_id" WITH =, "subject_id" WITH =, "valid_during" WITH &&);
