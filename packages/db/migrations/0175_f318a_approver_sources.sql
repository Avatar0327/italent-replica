-- DEC-686：迁移已有预置值至唯一来源结构；不保留旧列或运行时兼容模型。
CREATE FUNCTION pg_temp.f318_source(v text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN v IS NULL THEN NULL ELSE jsonb_build_object(
   'type', CASE v
   WHEN 'owner' THEN 'custom_variable'
   WHEN 'handover_hr_admin' THEN 'identity'
   WHEN 'latest_record_department_head' THEN 'department'
   WHEN 'latest_record_department_hrbp' THEN 'department'
   WHEN 'record_department_head' THEN 'department'
   WHEN 'record_department_hrbp' THEN 'department'
   WHEN 'record_first_level_org_head' THEN 'department'
   WHEN 'offer_department_head' THEN 'department'
   WHEN 'approval_subject_first_level_org_head' THEN 'department'
   ELSE 'object_field' END, 'value', v) END
$$;--> statement-breakpoint
CREATE FUNCTION pg_temp.f318_sources(v text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(jsonb_agg(pg_temp.f318_source(x) ORDER BY n), '[]'::jsonb) FROM unnest(v) WITH ORDINALITY AS a(x,n)
$$;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approver";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_approvers";--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ALTER COLUMN "approver_expression" SET DATA TYPE jsonb USING pg_temp.f318_source(approver_expression);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ALTER COLUMN "approver_expressions" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ALTER COLUMN "approver_expressions" SET DATA TYPE jsonb USING pg_temp.f318_sources(approver_expressions);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ALTER COLUMN "approver_expressions" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD COLUMN "empty_approver_sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_approvers" CHECK (CASE WHEN "approval_process_nodes"."node_type" = 'countersign'
        THEN "approval_process_nodes"."approver_expression" IS NULL AND jsonb_typeof("approval_process_nodes"."approver_expressions") = 'array'
          AND jsonb_array_length("approval_process_nodes"."approver_expressions") BETWEEN 1 AND 200
        ELSE "approval_process_nodes"."approver_expression" IS NOT NULL AND jsonb_typeof("approval_process_nodes"."approver_expression") = 'object'
          AND "approval_process_nodes"."approver_expressions" = '[]'::jsonb END);