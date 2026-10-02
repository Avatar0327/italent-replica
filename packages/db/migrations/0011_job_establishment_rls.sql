-- R1-T04 职务体系与编制：38 张租户表，复用底座统一隔离策略。
-- AGENTS.md §2/§10、docs/02_业务建模/18 §4/§10 与 19 §1–§3。
-- 稳定对象头只授予 revision 更新；业务版本、子项、导入、复制请求及投递记录只追加。
SELECT enable_tenant_isolation('job_layer_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_grade_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_level_type_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_level_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_sequence_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_professional_line_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_post_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_position_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_layer_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_grade_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_level_type_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_level_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_sequence_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_professional_line_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_post_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_position_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_settings_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_settings_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_import_mappings');
--> statement-breakpoint
SELECT enable_tenant_isolation('job_import_results');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_scheme_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_scheme_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_scheme_exclusions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_scheme_ranges');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_subdivisions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_settings');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_timing_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_movement_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_movement_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_copy_jobs');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_copy_job_versions');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_copy_job_items');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_notifications');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_notification_delivery_attempts');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_outbox');
--> statement-breakpoint
SELECT enable_tenant_isolation('establishment_outbox_delivery_attempts');
--> statement-breakpoint
GRANT SELECT, INSERT ON job_layer_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_grade_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_level_type_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_level_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_sequence_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_professional_line_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_post_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_position_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_layer_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_grade_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_level_type_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_level_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_sequence_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_professional_line_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_post_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_position_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_settings_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_settings_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_import_mappings TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON job_import_results TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_scheme_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_scheme_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_scheme_exclusions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_scheme_ranges TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_subdivisions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_settings TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_timing_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_movement_objects TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_movement_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_copy_jobs TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_copy_job_versions TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_copy_job_items TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_notifications TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_notification_delivery_attempts TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_outbox TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON establishment_outbox_delivery_attempts TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_layer_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_grade_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_level_type_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_level_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_sequence_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_professional_line_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_post_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_position_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON job_settings_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON establishment_scheme_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON establishment_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON establishment_settings TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON establishment_movement_objects TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision) ON establishment_copy_jobs TO app_user;
--> statement-breakpoint
CREATE TRIGGER job_layer_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_layer_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_grade_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_grade_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_level_type_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_level_type_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_level_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_level_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_sequence_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_sequence_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_professional_line_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_professional_line_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_post_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_post_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_position_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_position_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_settings_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_settings_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_import_mappings_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_import_mappings
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER job_import_results_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON job_import_results
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_scheme_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_scheme_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_scheme_exclusions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_scheme_exclusions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_scheme_ranges_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_scheme_ranges
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_subdivisions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_subdivisions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_timing_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_timing_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_movement_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_movement_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_copy_job_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_copy_job_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_copy_job_items_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_copy_job_items
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_notifications_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_notifications
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_notification_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_notification_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_outbox_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER establishment_outbox_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON establishment_outbox_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
