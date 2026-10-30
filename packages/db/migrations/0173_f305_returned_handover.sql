DROP INDEX "approval_instances_active_business";--> statement-breakpoint
CREATE UNIQUE INDEX "approval_instances_active_business" ON "approval_instances" USING btree ("tenant_id","business_type","business_id") WHERE ("approval_instances"."status" = 'running'
    OR ("approval_instances"."status" = 'returned' AND "approval_instances"."business_type" <> 'exit_handover'));