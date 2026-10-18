ALTER TABLE "idp_careers" ADD COLUMN "target_professional_line_id" uuid;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD COLUMN "target_level_id" uuid;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD COLUMN "target_post_id" uuid;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD COLUMN "current_level_id" uuid;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD COLUMN "current_position_id" uuid;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD COLUMN "current_post_id" uuid;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_target_line_fk" FOREIGN KEY ("tenant_id","target_professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_target_level_fk" FOREIGN KEY ("tenant_id","target_level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_target_post_fk" FOREIGN KEY ("tenant_id","target_post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_current_level_fk" FOREIGN KEY ("tenant_id","current_level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_current_position_fk" FOREIGN KEY ("tenant_id","current_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_careers" ADD CONSTRAINT "idp_careers_current_post_fk" FOREIGN KEY ("tenant_id","current_post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;