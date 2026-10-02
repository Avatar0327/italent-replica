-- 手写迁移：权限模型表（R1-T01，0014 生成）纳入租户隔离（硬规则 7）并授予最小权限。
-- 身份对象权限按“整对象替换”写入，所以子表需要 DELETE；授权、管理员记录撤销只改状态，不授 DELETE。
SELECT enable_tenant_isolation('permission_profiles');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_profile_apps');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_profile_objects');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_profile_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_profile_buttons');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_grants');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_admins');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_admin_grantable_roles');
--> statement-breakpoint
SELECT enable_tenant_isolation('permission_admin_grantable_profiles');
--> statement-breakpoint
SELECT enable_tenant_isolation('license_pools');
--> statement-breakpoint
SELECT enable_tenant_isolation('license_seats');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON permission_profiles, permission_grants, permission_admins, license_pools TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON permission_profile_apps, permission_profile_objects, permission_profile_fields,
  permission_profile_buttons, permission_admin_grantable_roles, permission_admin_grantable_profiles TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON license_seats TO app_user;
