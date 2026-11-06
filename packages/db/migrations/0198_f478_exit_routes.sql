CREATE TABLE "approval_node_activations" (
	"tenant_id" uuid NOT NULL,
	"activation_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"node_key" text NOT NULL,
	"entry_kind" text NOT NULL,
	"from_activation_id" uuid,
	"from_node_key" text,
	"from_exit" text,
	"from_branch_no" smallint,
	"created_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_node_activations_tenant_id_activation_id_pk" PRIMARY KEY("tenant_id","activation_id"),
	CONSTRAINT "approval_node_activations_kind" CHECK ("approval_node_activations"."entry_kind" IN ('start','flow','jump','reject_previous','resubmit')),
	CONSTRAINT "approval_node_activations_flow_exit" CHECK (("approval_node_activations"."entry_kind" = 'flow') = ("approval_node_activations"."from_exit" IS NOT NULL)),
	CONSTRAINT "approval_node_activations_start" CHECK ("approval_node_activations"."entry_kind" <> 'start' OR "approval_node_activations"."from_node_key" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "approval_node_exit_route_conditions" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"exit" text NOT NULL,
	"branch_no" smallint NOT NULL,
	"item_no" smallint NOT NULL,
	"field_path" text NOT NULL,
	"operator" text NOT NULL,
	"value_text" text,
	"value_list" text[],
	CONSTRAINT "approval_node_exit_route_conditions_tenant_id_version_id_node_key_exit_branch_no_item_no_pk" PRIMARY KEY("tenant_id","version_id","node_key","exit","branch_no","item_no"),
	CONSTRAINT "approval_exit_route_conditions_item_no" CHECK ("approval_node_exit_route_conditions"."item_no" BETWEEN 1 AND 20),
	CONSTRAINT "approval_exit_route_conditions_operator" CHECK ("approval_node_exit_route_conditions"."operator" IN ('eq','ne','in','not_in','is_empty','not_empty','in_org_tree')),
	CONSTRAINT "approval_exit_route_conditions_carrier" CHECK ("approval_node_exit_route_conditions"."value_text" IS NULL OR "approval_node_exit_route_conditions"."value_list" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "approval_node_exit_routes" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"exit" text NOT NULL,
	"branch_no" smallint NOT NULL,
	"kind" text NOT NULL,
	"priority" smallint,
	"expression" text,
	"target_node_key" text,
	CONSTRAINT "approval_node_exit_routes_tenant_id_version_id_node_key_exit_branch_no_pk" PRIMARY KEY("tenant_id","version_id","node_key","exit","branch_no"),
	CONSTRAINT "approval_exit_routes_kind" CHECK ("approval_node_exit_routes"."kind" IN ('condition','else','direct')),
	CONSTRAINT "approval_exit_routes_branch_no" CHECK ("approval_node_exit_routes"."branch_no" BETWEEN 1 AND 10),
	CONSTRAINT "approval_exit_routes_condition" CHECK (("approval_node_exit_routes"."kind" = 'condition') = ("approval_node_exit_routes"."priority" IS NOT NULL AND "approval_node_exit_routes"."expression" IS NOT NULL)),
	CONSTRAINT "approval_exit_routes_not_self" CHECK ("approval_node_exit_routes"."target_node_key" IS DISTINCT FROM "approval_node_exit_routes"."node_key")
);
--> statement-breakpoint
ALTER TABLE "approval_process_nodes" DROP CONSTRAINT "approval_nodes_exits";--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD COLUMN "decision_exit" text;--> statement-breakpoint
ALTER TABLE "approval_node_activations" ADD CONSTRAINT "approval_node_activations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_activations" ADD CONSTRAINT "approval_node_activations_instance_fk" FOREIGN KEY ("tenant_id","instance_id") REFERENCES "public"."approval_instances"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_exit_route_conditions" ADD CONSTRAINT "approval_node_exit_route_conditions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_exit_route_conditions" ADD CONSTRAINT "approval_exit_route_conditions_route_fk" FOREIGN KEY ("tenant_id","version_id","node_key","exit","branch_no") REFERENCES "public"."approval_node_exit_routes"("tenant_id","version_id","node_key","exit","branch_no") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_exit_routes" ADD CONSTRAINT "approval_node_exit_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_exit_routes" ADD CONSTRAINT "approval_exit_routes_node_fk" FOREIGN KEY ("tenant_id","version_id","node_key") REFERENCES "public"."approval_process_nodes"("tenant_id","version_id","node_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_node_exit_routes" ADD CONSTRAINT "approval_exit_routes_target_fk" FOREIGN KEY ("tenant_id","version_id","target_node_key") REFERENCES "public"."approval_process_nodes"("tenant_id","version_id","node_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_node_activations_instance" ON "approval_node_activations" USING btree ("tenant_id","instance_id","created_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_exit_routes_priority" ON "approval_node_exit_routes" USING btree ("tenant_id","version_id","node_key","exit","priority") WHERE "approval_node_exit_routes"."kind" = 'condition';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_exit_routes_else" ON "approval_node_exit_routes" USING btree ("tenant_id","version_id","node_key","exit") WHERE "approval_node_exit_routes"."kind" IN ('else','direct');--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_countersign_exits" CHECK ("approval_process_nodes"."node_type" = 'single' OR "approval_process_nodes"."exits" <@ ARRAY['approve','disagree']::text[]);--> statement-breakpoint
ALTER TABLE "approval_process_nodes" ADD CONSTRAINT "approval_nodes_exits" CHECK (cardinality("approval_process_nodes"."exits") BETWEEN 1 AND 3
        AND "approval_process_nodes"."exits" <@ ARRAY['approve','disagree','approve_no_rehire','approve_rehire']::text[]
        AND ('approve_no_rehire' = ANY("approval_process_nodes"."exits")) = ('approve_rehire' = ANY("approval_process_nodes"."exits"))
        AND NOT ('approve' = ANY("approval_process_nodes"."exits") AND 'approve_rehire' = ANY("approval_process_nodes"."exits")));--> statement-breakpoint
-- F-478 S1：租户隔离（ENABLE + FORCE RLS）与授权；路由表随版本冻结，激活台账只追加。
SELECT enable_tenant_isolation('approval_node_exit_routes');
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_node_exit_route_conditions');
--> statement-breakpoint
SELECT enable_tenant_isolation('approval_node_activations');
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "approval_node_exit_routes" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "approval_node_exit_route_conditions" TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON "approval_node_activations" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "approval_exit_routes_draft_only" BEFORE INSERT OR UPDATE OR DELETE
  ON "approval_node_exit_routes" FOR EACH ROW EXECUTE FUNCTION approval_version_child_guard();
--> statement-breakpoint
CREATE TRIGGER "approval_exit_route_conditions_draft_only" BEFORE INSERT OR UPDATE OR DELETE
  ON "approval_node_exit_route_conditions" FOR EACH ROW EXECUTE FUNCTION approval_version_child_guard();
--> statement-breakpoint
CREATE TRIGGER "approval_node_activations_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "approval_node_activations" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
