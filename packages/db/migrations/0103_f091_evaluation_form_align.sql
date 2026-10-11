ALTER TABLE "ev_forms" DROP CONSTRAINT "ev_forms_score_mode";--> statement-breakpoint
ALTER TABLE "ev_forms" DROP CONSTRAINT "ev_forms_total_rule_by_mode";--> statement-breakpoint
ALTER TABLE "ev_forms" DROP CONSTRAINT "ev_forms_scores";--> statement-breakpoint
ALTER TABLE "ev_forms" ALTER COLUMN "full_score" SET DATA TYPE numeric(17, 2);--> statement-breakpoint
ALTER TABLE "ev_forms" ALTER COLUMN "full_score" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ev_forms" ALTER COLUMN "pass_score" SET DATA TYPE numeric(17, 2);--> statement-breakpoint
ALTER TABLE "ev_forms" ALTER COLUMN "pass_score" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ev_forms" ADD COLUMN "vote_pass_ratio" numeric;--> statement-breakpoint
ALTER TABLE "ev_forms" ADD COLUMN "indicator_reference" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ev_form_items_general_once" ON "ev_form_items" USING btree ("tenant_id","form_id","general_item_id") WHERE "ev_form_items"."kind" = 'general';--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_scores_by_mode" CHECK (CASE WHEN "ev_forms"."score_mode" = 'by_vote' AND NOT "ev_forms"."indicator_reference"
      THEN "ev_forms"."full_score" IS NULL AND "ev_forms"."pass_score" IS NULL
      ELSE "ev_forms"."full_score" IS NOT NULL AND "ev_forms"."pass_score" IS NOT NULL END);--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_vote_settings" CHECK (("ev_forms"."score_mode" = 'by_vote') = ("ev_forms"."vote_pass_ratio" IS NOT NULL)
      AND ("ev_forms"."vote_pass_ratio" IS NULL OR ("ev_forms"."vote_pass_ratio" >= 0 AND "ev_forms"."vote_pass_ratio" <= 100))
      AND ("ev_forms"."score_mode" = 'by_vote' OR NOT "ev_forms"."indicator_reference"));--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_score_mode" CHECK ("ev_forms"."score_mode" IN ('by_indicator', 'by_total', 'by_vote'));--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_total_rule_by_mode" CHECK (("ev_forms"."score_mode" = 'by_indicator'
      OR ("ev_forms"."score_mode" = 'by_vote' AND "ev_forms"."indicator_reference")) = ("ev_forms"."total_rule" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_scores" CHECK (("ev_forms"."full_score" IS NULL OR ("ev_forms"."full_score" > 0 AND "ev_forms"."full_score" < 1000000000000000))
      AND ("ev_forms"."pass_score" IS NULL OR ("ev_forms"."pass_score" > 0 AND "ev_forms"."pass_score" < 1000000000000000)));