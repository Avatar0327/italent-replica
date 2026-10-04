ALTER TABLE "employment_timeline" DROP CONSTRAINT "employment_timeline_cycle_start";--> statement-breakpoint
ALTER TABLE "employment_timeline" DROP CONSTRAINT "employment_timeline_sort_order";--> statement-breakpoint
DROP INDEX "employment_timeline_employee_start";--> statement-breakpoint
ALTER TABLE "employment_timeline" ADD CONSTRAINT "employment_timeline_day_order" UNIQUE("tenant_id","employee_id","start_date","sort_order");--> statement-breakpoint
ALTER TABLE "employment_timeline" ADD CONSTRAINT "employment_timeline_sort_order" CHECK ("employment_timeline"."sort_order" >= 0);