SELECT enable_tenant_isolation('transfer_establishment_allocations');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON transfer_establishment_allocations TO app_user;
--> statement-breakpoint
CREATE FUNCTION protect_transfer_establishment_allocation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.reversed OR NOT NEW.reversed
    OR (to_jsonb(NEW)-'reversed') IS DISTINCT FROM (to_jsonb(OLD)-'reversed') THEN
    RAISE EXCEPTION 'establishment allocations may only reverse once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER transfer_establishment_allocation_reverse_once BEFORE UPDATE ON transfer_establishment_allocations
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_establishment_allocation();
--> statement-breakpoint
CREATE TRIGGER transfer_establishment_allocation_no_removal BEFORE DELETE OR TRUNCATE ON transfer_establishment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
