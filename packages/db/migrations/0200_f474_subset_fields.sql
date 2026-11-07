ALTER TABLE "personnel_awards" ADD COLUMN "amount" numeric;--> statement-breakpoint
ALTER TABLE "personnel_awards" ADD COLUMN "pay_date" date;--> statement-breakpoint
ALTER TABLE "personnel_awards_versions" ADD COLUMN "amount" numeric;--> statement-breakpoint
ALTER TABLE "personnel_awards_versions" ADD COLUMN "pay_date" date;--> statement-breakpoint
ALTER TABLE "personnel_language_ability" ADD COLUMN "acquired_certificate" text;--> statement-breakpoint
ALTER TABLE "personnel_language_ability_versions" ADD COLUMN "acquired_certificate" text;--> statement-breakpoint
ALTER TABLE "personnel_training" ADD COLUMN "category_name" text;--> statement-breakpoint
ALTER TABLE "personnel_training" ADD COLUMN "classification" text;--> statement-breakpoint
ALTER TABLE "personnel_training_versions" ADD COLUMN "category_name" text;--> statement-breakpoint
ALTER TABLE "personnel_training_versions" ADD COLUMN "classification" text;