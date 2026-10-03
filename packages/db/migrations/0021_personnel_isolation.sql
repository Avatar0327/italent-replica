-- R1-T12：显式人员表强制隔离；版本只追加，当前子集由同事务快照保护。
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_awards');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_awards" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_awards_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_awards_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_awards_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_awards_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_certificate');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_certificate" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_certificate_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_certificate_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_certificate_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_certificate_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_change_requests');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_change_requests" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_education');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_education" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_education_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_education_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_education_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_education_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_employee_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_employee_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_employee_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_employee_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_estimation_result');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_estimation_result" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_estimation_result_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_estimation_result_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_estimation_result_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_estimation_result_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_family');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_family" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_family_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_family_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_family_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_family_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_job_history');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_job_history" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_job_history_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_job_history_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_job_history_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_job_history_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_language_ability');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_language_ability" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_language_ability_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_language_ability_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_language_ability_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_language_ability_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_outbox" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_professional_technical_post');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_professional_technical_post" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_professional_technical_post_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_professional_technical_post_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_professional_technical_post_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_professional_technical_post_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_project_experience');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_project_experience" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_project_experience_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_project_experience_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_project_experience_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_project_experience_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_punish');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_punish" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_punish_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_punish_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_punish_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_punish_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_skill');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_skill" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_skill_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_skill_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_skill_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_skill_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_training');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_training" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_training_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_training_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_training_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_training_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_vocational_qualification');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_vocational_qualification" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_vocational_qualification_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_vocational_qualification_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_vocational_qualification_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_vocational_qualification_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
REVOKE UPDATE ON personnel_change_requests FROM app_user;
--> statement-breakpoint
GRANT UPDATE (status,revision) ON personnel_change_requests TO app_user;
--> statement-breakpoint
CREATE FUNCTION personnel_check_request_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type='self_service' AND NOT EXISTS (
    SELECT 1 FROM personnel_change_requests r WHERE r.tenant_id=NEW.tenant_id
      AND r.employee_id=NEW.employee_id AND r.id=NEW.source_id AND r.subset=TG_ARGV[0]
  ) THEN
    RAISE EXCEPTION 'invalid personnel request source' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
CREATE TRIGGER personnel_education_source_check BEFORE INSERT OR UPDATE ON personnel_education
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('education');

--> statement-breakpoint
CREATE TRIGGER personnel_job_history_source_check BEFORE INSERT OR UPDATE ON personnel_job_history
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('jobhistory');

--> statement-breakpoint
CREATE TRIGGER personnel_family_source_check BEFORE INSERT OR UPDATE ON personnel_family
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('family');

--> statement-breakpoint
CREATE TRIGGER personnel_training_source_check BEFORE INSERT OR UPDATE ON personnel_training
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('training');

--> statement-breakpoint
CREATE TRIGGER personnel_certificate_source_check BEFORE INSERT OR UPDATE ON personnel_certificate
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('certificate');

--> statement-breakpoint
CREATE TRIGGER personnel_awards_source_check BEFORE INSERT OR UPDATE ON personnel_awards
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('awards');

--> statement-breakpoint
CREATE TRIGGER personnel_project_experience_source_check BEFORE INSERT OR UPDATE ON personnel_project_experience
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('project-experience');

--> statement-breakpoint
CREATE TRIGGER personnel_skill_source_check BEFORE INSERT OR UPDATE ON personnel_skill
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('skill');

--> statement-breakpoint
CREATE TRIGGER personnel_language_ability_source_check BEFORE INSERT OR UPDATE ON personnel_language_ability
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('language-ability');

--> statement-breakpoint
CREATE TRIGGER personnel_estimation_result_source_check BEFORE INSERT OR UPDATE ON personnel_estimation_result
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('estimation-result');

--> statement-breakpoint
CREATE TRIGGER personnel_punish_source_check BEFORE INSERT OR UPDATE ON personnel_punish
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('punish');

--> statement-breakpoint
CREATE TRIGGER personnel_professional_technical_post_source_check BEFORE INSERT OR UPDATE ON personnel_professional_technical_post
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('professional-technical-post');

--> statement-breakpoint
CREATE TRIGGER personnel_vocational_qualification_source_check BEFORE INSERT OR UPDATE ON personnel_vocational_qualification
  FOR EACH ROW EXECUTE FUNCTION personnel_check_request_source('vocational-qualification');
