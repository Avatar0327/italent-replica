-- R3-T03 360 度评估：统一租户隔离（硬规则 7）；关联日志、计分批次与得分只追加（AGENTS.md §10「审计」）。
SELECT enable_tenant_isolation('survey360_settings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_settings TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_people');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_people TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_person_link_logs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_person_link_logs TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_sync_conflicts');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_sync_conflicts TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_roles');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_roles TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_questionnaires');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_questionnaires TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_questionnaire_roles');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_questionnaire_roles TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_scales');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_scales TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_scale_options');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_scale_options TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_dimensions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_dimensions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_questions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_questions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_activities');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_activities TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_activity_grants');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_activity_grants TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_objects');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_objects TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_object_questionnaires');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_object_questionnaires TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_relations');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_relations TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_confirmations');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_confirmations TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_links');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_links TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_outbox TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_sheets');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_sheets TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_answers');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_answers TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_score_batches');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_score_batches TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_scores');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_scores TO app_user;
--> statement-breakpoint
CREATE TRIGGER survey360_person_link_logs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON survey360_person_link_logs
FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER survey360_score_batches_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON survey360_score_batches
FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER survey360_scores_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON survey360_scores
FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
