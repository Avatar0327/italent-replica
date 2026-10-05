DROP INDEX "contract_job_lookup";--> statement-breakpoint
ALTER TABLE "contract_job_attempts" ADD COLUMN "attempt_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_records" ADD COLUMN "termination_reason" text;--> statement-breakpoint
-- F-013：生成的唯一约束前先压缩旧尝试；成功是终态，避免旧 failed/unknown 令任务重复执行。
DROP TRIGGER contract_job_attempts_append_only ON contract_job_attempts;
--> statement-breakpoint
WITH ranked AS (
  SELECT id, count(*) OVER (PARTITION BY tenant_id,object_id,kind)::integer AS total,
    row_number() OVER (PARTITION BY tenant_id,object_id,kind
      ORDER BY (state='succeeded') DESC,created_at DESC,id DESC) AS rank
  FROM contract_job_attempts
)
UPDATE contract_job_attempts a SET attempt_count=r.total
FROM ranked r WHERE a.id=r.id AND r.rank=1;
--> statement-breakpoint
WITH ranked AS (
  SELECT id,row_number() OVER (PARTITION BY tenant_id,object_id,kind
    ORDER BY (state='succeeded') DESC,created_at DESC,id DESC) AS rank
  FROM contract_job_attempts
)
DELETE FROM contract_job_attempts a USING ranked r WHERE a.id=r.id AND r.rank>1;
--> statement-breakpoint
ALTER TABLE "contract_job_attempts" ADD CONSTRAINT "contract_job_lookup" UNIQUE("tenant_id","object_id","kind");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_contract_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','actual_termination_date','termination_reason','revision','deleted']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','actual_termination_date','termination_reason','revision','deleted']) THEN
    RAISE EXCEPTION 'contract business fields are immutable; append a version';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- 历史来源没有独立原因字段：仅确定到期且未被变更替代的记录可恢复，其余保守保护。
UPDATE contract_records c SET termination_reason=CASE
  WHEN EXISTS (SELECT 1 FROM contract_changes h WHERE h.tenant_id=c.tenant_id AND h.before_contract_id=c.id)
    THEN 'change'
  WHEN c.end_date IS NOT NULL AND c.actual_termination_date=c.end_date THEN 'expiry'
  ELSE 'unknown' END
WHERE c.status='terminated';
