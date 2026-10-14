ALTER TABLE "succession_map_preferences" DROP CONSTRAINT "succession_preferences_kind";--> statement-breakpoint
ALTER TABLE "succession_map_preferences" DROP COLUMN "hide_virtual";--> statement-breakpoint
ALTER TABLE "succession_map_preferences" DROP COLUMN "show_incumbents";--> statement-breakpoint
ALTER TABLE "succession_map_preferences" ADD CONSTRAINT "succession_preferences_kind" CHECK ("succession_map_preferences"."map_kind" = 'position');