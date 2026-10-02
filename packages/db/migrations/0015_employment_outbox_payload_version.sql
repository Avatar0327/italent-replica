-- DEC-019：事件类型保持稳定，用 payload 版本标识同一命令的多次向后更新。
ALTER TABLE "employment_outbox" ADD COLUMN "payload_version_id" uuid;--> statement-breakpoint
ALTER TABLE "employment_outbox" DROP CONSTRAINT "employment_outbox_command_event";--> statement-breakpoint
ALTER TABLE "employment_outbox" ADD CONSTRAINT "employment_outbox_command_event"
  UNIQUE("tenant_id","command_id","event_type","object_id","payload_version_id");
