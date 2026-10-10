CREATE TABLE "ev_form_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"general_item_id" uuid,
	"weight" numeric(5, 2),
	"hidden_target_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "ev_form_items_seq" UNIQUE("tenant_id","form_id","seq"),
	CONSTRAINT "ev_form_items_kind" CHECK ("ev_form_items"."kind" IN ('standard', 'general')),
	CONSTRAINT "ev_form_items_shape" CHECK (("ev_form_items"."kind" = 'general') = ("ev_form_items"."general_item_id" IS NOT NULL)
        AND ("ev_form_items"."kind" = 'standard' OR cardinality("ev_form_items"."hidden_target_ids") = 0)),
	CONSTRAINT "ev_form_items_weight" CHECK ("ev_form_items"."weight" IS NULL OR ("ev_form_items"."weight" >= 0 AND "ev_form_items"."weight" <= 100))
);
--> statement-breakpoint
CREATE TABLE "ev_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"score_mode" text NOT NULL,
	"full_score" numeric(8, 2) NOT NULL,
	"pass_score" numeric(8, 2) NOT NULL,
	"total_rule" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_forms_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_forms_score_mode" CHECK ("ev_forms"."score_mode" IN ('by_indicator', 'by_total')),
	CONSTRAINT "ev_forms_total_rule" CHECK ("ev_forms"."total_rule" IN ('average', 'weighted', 'sum')),
	CONSTRAINT "ev_forms_total_rule_by_mode" CHECK (("ev_forms"."score_mode" = 'by_indicator') = ("ev_forms"."total_rule" IS NOT NULL)),
	CONSTRAINT "ev_forms_scores" CHECK ("ev_forms"."full_score" > 0 AND "ev_forms"."pass_score" >= 0 AND "ev_forms"."pass_score" <= "ev_forms"."full_score")
);
--> statement-breakpoint
ALTER TABLE "ev_form_items" ADD CONSTRAINT "ev_form_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_form_items" ADD CONSTRAINT "ev_form_items_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."ev_forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_form_items" ADD CONSTRAINT "ev_form_items_general_fk" FOREIGN KEY ("tenant_id","general_item_id") REFERENCES "public"."ev_general_items"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_forms" ADD CONSTRAINT "ev_forms_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ev_form_items_standard" ON "ev_form_items" USING btree ("tenant_id","form_id") WHERE "ev_form_items"."kind" = 'standard';--> statement-breakpoint
CREATE INDEX "ev_form_items_general" ON "ev_form_items" USING btree ("tenant_id","general_item_id");--> statement-breakpoint
CREATE INDEX "ev_forms_owner_org" ON "ev_forms" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
-- R3-T02 PR-B B4：统一租户隔离（AGENTS §2；guard-rls）。评分项随评价表整组替换，应用角色需要 DELETE。
SELECT enable_tenant_isolation('ev_forms');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_forms TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ev_form_items');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_form_items TO app_user;
