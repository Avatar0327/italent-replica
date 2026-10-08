-- F-038：复用现有租户隔离函数；无 tenant 上下文默认不可访问。
SELECT enable_tenant_isolation('talent_model_image_attachments');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_model_image_attachments TO app_user;
