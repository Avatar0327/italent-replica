CREATE TABLE "seed_grant_ledger" (
	"tenant_id" uuid DEFAULT current_tenant_id() NOT NULL,
	"entry" text NOT NULL,
	"code" text NOT NULL,
	"source" text NOT NULL,
	"command_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seed_grant_ledger_tenant_id_entry_code_pk" PRIMARY KEY("tenant_id","entry","code"),
	CONSTRAINT "seed_grant_ledger_source_valid" CHECK ("seed_grant_ledger"."source" IN ('install', 'adopted', 'tenant_saved', 'withheld'))
);
--> statement-breakpoint
ALTER TABLE "seed_grant_ledger" ADD CONSTRAINT "seed_grant_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;