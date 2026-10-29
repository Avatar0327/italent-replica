ALTER TABLE "transfer_linkage_items" DROP CONSTRAINT "transfer_linkage_items_status";--> statement-breakpoint
ALTER TABLE "transfer_linkage_items" DROP CONSTRAINT "transfer_linkage_items_failure";--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD COLUMN "manual_plan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD COLUMN "supersedes_business_id" uuid;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_supersedes_fk" FOREIGN KEY ("tenant_id","employee_id","supersedes_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_requests" ADD CONSTRAINT "exit_requests_one_successor" UNIQUE("tenant_id","supersedes_business_id");--> statement-breakpoint
ALTER TABLE "transfer_linkage_items" ADD CONSTRAINT "transfer_linkage_items_status" CHECK ("transfer_linkage_items"."status" IN ('pending', 'succeeded', 'failed', 'superseded'));--> statement-breakpoint
ALTER TABLE "transfer_linkage_items" ADD CONSTRAINT "transfer_linkage_items_failure" CHECK (("transfer_linkage_items"."status" IN ('failed', 'superseded')) = ("transfer_linkage_items"."failure_code" IS NOT NULL));
--> statement-breakpoint
-- F-140：只有专用人工快照可重设计划；普通派生继续继承。
CREATE OR REPLACE FUNCTION employment_payload_planned_date() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_planned date;
BEGIN
  IF NEW.manual_plan OR NEW.trigger_business_id IS NULL OR NEW.previous_version_id IS NULL THEN
    v_planned := NEW.effective_date;
  ELSE
    SELECT p.planned_effective_date INTO v_planned FROM employment_payload_versions p
      WHERE p.tenant_id = NEW.tenant_id AND p.business_id = NEW.business_id AND p.id = NEW.previous_version_id;
    IF v_planned IS NULL THEN
      RAISE EXCEPTION 'employment payload version % has no previous planned effective date', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.planned_effective_date := v_planned;
  RETURN NEW;
END $$;

--> statement-breakpoint
-- 重定位后实际日期取时间轴 / 最新记录快照；不可变底表保留首次日期，不能用于重新摘挂的顺序。
CREATE OR REPLACE FUNCTION employment_follows(p_tenant uuid, p_anchor uuid, p_record uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  WITH keys AS (
    SELECT r.id, COALESCE(
      (SELECT t.start_date FROM public.employment_timeline t WHERE t.tenant_id=r.tenant_id AND t.record_id=r.id),
      (SELECT p.effective_date FROM public.employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1), r.start_date) AS start_date,
      (SELECT p.planned_effective_date FROM public.employment_payload_versions p
        WHERE p.tenant_id = r.tenant_id AND p.business_id = r.id ORDER BY p.version_no DESC LIMIT 1) AS planned,
      (SELECT COALESCE(max(e.event_seq) FILTER (WHERE e.state = 'in_review'), min(e.event_seq))
        FROM public.employment_state_events e WHERE e.tenant_id = r.tenant_id AND e.business_id = r.id) AS operation
    FROM public.employment_records r
    WHERE r.tenant_id = p_tenant AND r.id IN (p_anchor, p_record)
  )
  SELECT EXISTS (
    SELECT 1 FROM keys a, keys r
    WHERE a.id = p_anchor AND r.id = p_record AND a.id <> r.id
      AND (r.start_date > a.start_date OR (r.start_date = a.start_date AND (r.planned > a.planned
        OR (r.planned = a.planned AND r.operation > a.operation))))
  );
$$;
