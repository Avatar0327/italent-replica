ALTER TABLE "employment_payload_versions" ADD COLUMN "work_year_company_before" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_records" ADD COLUMN "work_year_company_before" numeric DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_seniority_correction" CHECK ("employment_payload_versions"."work_year_company_before" >= 0
      AND "employment_payload_versions"."work_year_company_before" <= 90071992547409.9
      AND "employment_payload_versions"."work_year_company_before" = trunc("employment_payload_versions"."work_year_company_before", 2));--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_seniority_correction" CHECK ("employment_records"."work_year_company_before" >= 0
      AND "employment_records"."work_year_company_before" <= 90071992547409.9
      AND "employment_records"."work_year_company_before" = trunc("employment_records"."work_year_company_before", 2));