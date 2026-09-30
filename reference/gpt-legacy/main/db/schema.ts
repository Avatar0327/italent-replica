import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, uniqueIndex, index, foreignKey } from 'drizzle-orm/sqlite-core';
export const workspaces=sqliteTable('hris_workspaces',{owner:text('owner').primaryKey(),revision:integer('revision').notNull().default(0),data:text('data').notNull(),storageVersion:integer('storage_version').notNull().default(0),lastMutation:text('last_mutation').notNull().default('')});
// owner is retained as the legacy column name; new records use an opaque tenant ID.
export const memberships=sqliteTable('hris_memberships',{
 userId:text('user_id').primaryKey(),tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),
 role:text('role',{enum:['admin','hr','manager','approver','employee']}).notNull(),
 orgScope:text('org_scope').notNull().default('[]'),viewEmail:integer('view_email').notNull().default(0),viewLevel:integer('view_level').notNull().default(0),employeeId:text('employee_id'),active:integer('active',{mode:'boolean'}).notNull().default(true),
});
export const auditEvents=sqliteTable('hris_audit_events',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),
 actorId:text('actor_id').notNull(),action:text('action').notNull(),subject:text('subject').notNull(),
 at:text('at').notNull(),revision:integer('revision').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]})]);

export const accessGrants=sqliteTable('hris_access_grants',{
 email:text('email').primaryKey(),tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),
 name:text('name').notNull(),role:text('role').notNull(),orgScope:text('org_scope').notNull().default('[]'),viewEmail:integer('view_email').notNull().default(0),viewLevel:integer('view_level').notNull().default(0),employeeId:text('employee_id'),
 active:integer('active').notNull().default(1),claimedBy:text('claimed_by'),updatedAt:text('updated_at').notNull(),
},t=>[index('idx_grants_tenant').on(t.tenantId),uniqueIndex('uq_grants_active_employee').on(t.tenantId,t.employeeId).where(sql`${t.active} = 1 AND ${t.employeeId} IS NOT NULL`)]);
export const installation=sqliteTable('hris_installation',{
 id:text('id').primaryKey(),tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),
 ownerId:text('owner_id').notNull(),name:text('name').notNull(),createdAt:text('created_at').notNull(),
});

export const orgs=sqliteTable('hris_orgs',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),name:text('name').notNull(),parentId:text('parent_id'),city:text('city').notNull(),leader:text('leader').notNull(),status:text('status').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),foreignKey({columns:[t.tenantId,t.parentId],foreignColumns:[t.tenantId,t.id]}),index('idx_org_parent').on(t.tenantId,t.parentId)]);
export const employees=sqliteTable('hris_employees',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),code:text('code').notNull(),name:text('name').notNull(),orgId:text('org_id').notNull(),job:text('job').notNull(),level:text('level').notNull(),joined:text('joined').notNull(),status:text('status').notNull(),email:text('email').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),uniqueIndex('uq_employee_code').on(t.tenantId,t.code),foreignKey({columns:[t.tenantId,t.orgId],foreignColumns:[orgs.tenantId,orgs.id]}),index('idx_employee_org').on(t.tenantId,t.orgId)]);
export const approvals=sqliteTable('hris_approvals',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),employeeId:text('employee_id').notNull(),kind:text('kind').notNull(),orgId:text('org_id').notNull(),reason:text('reason').notNull(),status:text('status').notNull(),created:text('created').notNull(),createdBy:text('created_by'),decided:text('decided'),decidedBy:text('decided_by'),currentStep:integer('current_step'),workflowVersion:integer('workflow_version'),details:text('details'),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),foreignKey({columns:[t.tenantId,t.employeeId],foreignColumns:[employees.tenantId,employees.id]}),foreignKey({columns:[t.tenantId,t.orgId],foreignColumns:[orgs.tenantId,orgs.id]}),index('idx_approval_status').on(t.tenantId,t.status),uniqueIndex('uq_pending_employee').on(t.tenantId,t.employeeId).where(sql`${t.status} = 'pending'`)]);
export const approvalSteps=sqliteTable('hris_approval_steps',{
 tenantId:text('tenant_id').notNull(),approvalId:text('approval_id').notNull(),position:integer('position').notNull(),userId:text('user_id').notNull(),name:text('name').notNull(),decision:text('decision'),at:text('at'),
},t=>[primaryKey({columns:[t.tenantId,t.approvalId,t.position]}),foreignKey({columns:[t.tenantId,t.approvalId],foreignColumns:[approvals.tenantId,approvals.id]}),index('idx_step_assignee').on(t.tenantId,t.userId)]);
export const workflows=sqliteTable('hris_workflows',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),kind:text('kind').notNull(),version:integer('version').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.kind,t.version]})]);
export const workflowSteps=sqliteTable('hris_workflow_steps',{
 tenantId:text('tenant_id').notNull(),kind:text('kind').notNull(),version:integer('version').notNull(),position:integer('position').notNull(),userId:text('user_id').notNull(),name:text('name').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.kind,t.version,t.position]}),foreignKey({columns:[t.tenantId,t.kind,t.version],foreignColumns:[workflows.tenantId,workflows.kind,workflows.version]})]);
export const employmentHistory=sqliteTable('hris_employment_history',{
 tenantId:text('tenant_id').notNull(),id:text('id').notNull(),employeeId:text('employee_id').notNull(),eventId:text('event_id').notNull(),at:text('at').notNull(),actorId:text('actor_id').notNull(),fromOrgId:text('from_org_id'),toOrgId:text('to_org_id').notNull(),fromStatus:text('from_status'),toStatus:text('to_status').notNull(),job:text('job').notNull(),level:text('level').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),foreignKey({columns:[t.tenantId,t.employeeId],foreignColumns:[employees.tenantId,employees.id]}),index('idx_history_employee').on(t.tenantId,t.employeeId,t.at)]);

export const grades=sqliteTable('hris_grades',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),code:text('code').notNull(),name:text('name').notNull(),sequence:integer('sequence').notNull(),status:text('status').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),uniqueIndex('uq_grade_code').on(t.tenantId,t.code)]);
export const positions=sqliteTable('hris_positions',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),code:text('code').notNull(),name:text('name').notNull(),orgId:text('org_id').notNull(),family:text('family').notNull(),responsibilities:text('responsibilities').notNull(),status:text('status').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),uniqueIndex('uq_position_code').on(t.tenantId,t.code),foreignKey({columns:[t.tenantId,t.orgId],foreignColumns:[orgs.tenantId,orgs.id]})]);
export const employeePositions=sqliteTable('hris_employee_positions',{
 tenantId:text('tenant_id').notNull(),employeeId:text('employee_id').notNull(),positionId:text('position_id'),gradeId:text('grade_id'),
},t=>[primaryKey({columns:[t.tenantId,t.employeeId]}),foreignKey({columns:[t.tenantId,t.employeeId],foreignColumns:[employees.tenantId,employees.id]}),foreignKey({columns:[t.tenantId,t.positionId],foreignColumns:[positions.tenantId,positions.id]}),foreignKey({columns:[t.tenantId,t.gradeId],foreignColumns:[grades.tenantId,grades.id]})]);
export const assignmentRequests=sqliteTable('hris_assignment_requests',{
 tenantId:text('tenant_id').notNull(),approvalId:text('approval_id').notNull(),positionId:text('position_id'),gradeId:text('grade_id'),
},t=>[primaryKey({columns:[t.tenantId,t.approvalId]}),foreignKey({columns:[t.tenantId,t.approvalId],foreignColumns:[approvals.tenantId,approvals.id]}),foreignKey({columns:[t.tenantId,t.positionId],foreignColumns:[positions.tenantId,positions.id]}),foreignKey({columns:[t.tenantId,t.gradeId],foreignColumns:[grades.tenantId,grades.id]})]);

// Versioned business documents: stable entity references are foreign keys; bounded
// structured rubric/evidence payloads preserve the exact version used in decisions.
export const developmentRecords=sqliteTable('hris_development_records',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),kind:text('kind').notNull(),employeeId:text('employee_id'),positionId:text('position_id'),referenceId:text('reference_id'),status:text('status').notNull(),payload:text('payload').notNull(),createdBy:text('created_by').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),foreignKey({columns:[t.tenantId,t.employeeId],foreignColumns:[employees.tenantId,employees.id]}),foreignKey({columns:[t.tenantId,t.positionId],foreignColumns:[positions.tenantId,positions.id]}),foreignKey({columns:[t.tenantId,t.referenceId],foreignColumns:[t.tenantId,t.id]}),index('idx_development_kind').on(t.tenantId,t.kind,t.status),index('idx_development_employee').on(t.tenantId,t.employeeId,t.kind)]);
export const attachments=sqliteTable('hris_attachments',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),employeeId:text('employee_id'),recordId:text('record_id'),objectKey:text('object_key').notNull(),visibility:text('visibility').notNull().default('hr'),name:text('name').notNull(),mime:text('mime').notNull(),size:integer('size').notNull(),createdBy:text('created_by').notNull(),createdAt:text('created_at').notNull(),deletedAt:text('deleted_at'),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),foreignKey({columns:[t.tenantId,t.employeeId],foreignColumns:[employees.tenantId,employees.id]}),foreignKey({columns:[t.tenantId,t.recordId],foreignColumns:[developmentRecords.tenantId,developmentRecords.id]}),uniqueIndex('uq_attachment_key').on(t.objectKey),index('idx_attachment_employee').on(t.tenantId,t.employeeId)]);
export const developmentEvents=sqliteTable('hris_development_events',{
 tenantId:text('tenant_id').notNull(),id:text('id').notNull(),recordId:text('record_id').notNull(),revision:integer('revision').notNull(),action:text('action').notNull(),actorId:text('actor_id').notNull(),at:text('at').notNull(),snapshot:text('snapshot').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),foreignKey({columns:[t.tenantId,t.recordId],foreignColumns:[developmentRecords.tenantId,developmentRecords.id]}),index('idx_development_events').on(t.tenantId,t.recordId,t.revision)]);
