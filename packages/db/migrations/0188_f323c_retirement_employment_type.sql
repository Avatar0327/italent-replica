-- F-323c：退休固定年龄条件补「人员类别」第 6 槽（seq 6，字典 ID 文本）；0176 同款改约束，既有数据不动
ALTER TABLE "retirement_rule_conditions" DROP CONSTRAINT "retirement_rule_conditions_seq";--> statement-breakpoint
ALTER TABLE "retirement_rule_conditions" DROP CONSTRAINT "retirement_rule_conditions_field";--> statement-breakpoint
ALTER TABLE "retirement_rule_conditions" ADD CONSTRAINT "retirement_rule_conditions_seq" CHECK ("retirement_rule_conditions"."seq" BETWEEN 1 AND 6);--> statement-breakpoint
ALTER TABLE "retirement_rule_conditions" ADD CONSTRAINT "retirement_rule_conditions_field" CHECK ("retirement_rule_conditions"."field_code" IN ('gender', 'nationality', 'employType', 'identityType', 'employmentForm', 'employmentType'));
