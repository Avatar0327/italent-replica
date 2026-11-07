ALTER TABLE "employment_cycles" DROP CONSTRAINT "employment_cycles_entry_type";--> statement-breakpoint
ALTER TABLE "employment_cycles" ADD COLUMN "trainee_start_date" date;--> statement-breakpoint
ALTER TABLE "employment_cycles" ADD CONSTRAINT "employment_cycles_trainee_start" CHECK ("employment_cycles"."trainee_start_date" IS NULL OR ("employment_cycles"."entry_type" = 'intern_regularization' AND "employment_cycles"."trainee_start_date" <= "employment_cycles"."entry_date"));--> statement-breakpoint
ALTER TABLE "employment_cycles" ADD CONSTRAINT "employment_cycles_entry_type" CHECK ("employment_cycles"."entry_type" IN ('hire', 'rehire', 'retire_rehire', 'intern_regularization'));--> statement-breakpoint
-- DEC-797 更正 0194 注释的口径（迁移只增不改，故在此说明）：0194 写“实习与退休返聘不登记配置”，
-- 现实习转正也有独立开关（与重聘开关互不影响）；退休返聘开关不在本迁移范围，仍未登记。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('employment.intern_regularization_accumulate_seniority','true'::jsonb,'【实习转正】累计司龄',true,1,now());
