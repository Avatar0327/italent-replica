ALTER TABLE personnel_education DROP CONSTRAINT personnel_education_source;
--> statement-breakpoint
ALTER TABLE personnel_education ADD CONSTRAINT personnel_education_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_education_versions ADD CONSTRAINT personnel_education_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_job_history DROP CONSTRAINT personnel_job_history_source;
--> statement-breakpoint
ALTER TABLE personnel_job_history ADD CONSTRAINT personnel_job_history_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_job_history_versions ADD CONSTRAINT personnel_job_history_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_family DROP CONSTRAINT personnel_family_source;
--> statement-breakpoint
ALTER TABLE personnel_family ADD CONSTRAINT personnel_family_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_family_versions ADD CONSTRAINT personnel_family_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_training DROP CONSTRAINT personnel_training_source;
--> statement-breakpoint
ALTER TABLE personnel_training ADD CONSTRAINT personnel_training_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_training_versions ADD CONSTRAINT personnel_training_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_certificate DROP CONSTRAINT personnel_certificate_source;
--> statement-breakpoint
ALTER TABLE personnel_certificate ADD CONSTRAINT personnel_certificate_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_certificate_versions ADD CONSTRAINT personnel_certificate_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_awards DROP CONSTRAINT personnel_awards_source;
--> statement-breakpoint
ALTER TABLE personnel_awards ADD CONSTRAINT personnel_awards_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_awards_versions ADD CONSTRAINT personnel_awards_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_project_experience DROP CONSTRAINT personnel_project_experience_source;
--> statement-breakpoint
ALTER TABLE personnel_project_experience ADD CONSTRAINT personnel_project_experience_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_project_experience_versions ADD CONSTRAINT personnel_project_experience_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_skill DROP CONSTRAINT personnel_skill_source;
--> statement-breakpoint
ALTER TABLE personnel_skill ADD CONSTRAINT personnel_skill_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_skill_versions ADD CONSTRAINT personnel_skill_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_language_ability DROP CONSTRAINT personnel_language_ability_source;
--> statement-breakpoint
ALTER TABLE personnel_language_ability ADD CONSTRAINT personnel_language_ability_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_language_ability_versions ADD CONSTRAINT personnel_language_ability_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_estimation_result DROP CONSTRAINT personnel_estimation_result_source;
--> statement-breakpoint
ALTER TABLE personnel_estimation_result ADD CONSTRAINT personnel_estimation_result_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_estimation_result_versions ADD CONSTRAINT personnel_estimation_result_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_punish DROP CONSTRAINT personnel_punish_source;
--> statement-breakpoint
ALTER TABLE personnel_punish ADD CONSTRAINT personnel_punish_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_punish_versions ADD CONSTRAINT personnel_punish_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_professional_technical_post DROP CONSTRAINT personnel_professional_technical_post_source;
--> statement-breakpoint
ALTER TABLE personnel_professional_technical_post ADD CONSTRAINT personnel_professional_technical_post_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_professional_technical_post_versions ADD CONSTRAINT personnel_professional_technical_post_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_vocational_qualification DROP CONSTRAINT personnel_vocational_qualification_source;
--> statement-breakpoint
ALTER TABLE personnel_vocational_qualification ADD CONSTRAINT personnel_vocational_qualification_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
ALTER TABLE personnel_vocational_qualification_versions ADD CONSTRAINT personnel_vocational_qualification_versions_source CHECK (source_type IN ('hr_direct','self_service','info_collection','employment_sync') AND ((source_type='hr_direct' AND source_id IS NULL) OR (source_type<>'hr_direct' AND source_id IS NOT NULL)));
--> statement-breakpoint
