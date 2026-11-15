-- F-474-8c-2c（设计 §3.3 / DEC-402）：联动子项追加 insurance_archive；直接改 CHECK，不加兼容。
ALTER TABLE "transfer_linkage_items" DROP CONSTRAINT "transfer_linkage_items_type";--> statement-breakpoint
ALTER TABLE "transfer_linkage_items" ADD CONSTRAINT "transfer_linkage_items_type" CHECK ("transfer_linkage_items"."item_type" IN ('duty_subordinate', 'duty_org_role', 'part_time_end', 'insurance_archive'));