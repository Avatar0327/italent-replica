CREATE TABLE personnel_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  employee_id uuid NOT NULL, purpose text NOT NULL, filename text NOT NULL, content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size >= 0), sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','uploaded','pending_cleanup')),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personnel_attachments_tenant_id UNIQUE(tenant_id,id),
  CONSTRAINT personnel_attachments_employee_fk FOREIGN KEY(tenant_id,employee_id)
    REFERENCES employment_employees(tenant_id,id)
);
--> statement-breakpoint
ALTER TABLE personnel_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE personnel_attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY personnel_attachments_tenant_isolation ON personnel_attachments
USING (tenant_id=current_setting('app.tenant_id',true)::uuid)
WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid);
