import {sqliteTable,text,integer,primaryKey,uniqueIndex,index,foreignKey} from 'drizzle-orm/sqlite-core';
import {workspaces} from './schema';
export const r1SchemaState=sqliteTable('r1_schema_state',{
 tenantId:text('tenant_id').primaryKey().references(()=>workspaces.owner),schemaVersion:integer('schema_version').notNull().default(1),
 writerEpoch:integer('writer_epoch').notNull().default(1),recoveryEpoch:integer('recovery_epoch').notNull().default(1),authorizationRevision:integer('authorization_revision').notNull().default(1),
 phase:text('phase').notNull().default('writers_guarded'),openGate:integer('open_gate').notNull().default(1),featuresEnabled:integer('features_enabled').notNull().default(0),
});
export const r1Commands=sqliteTable('r1_commands',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),commandId:text('command_id').notNull(),actorId:text('actor_id').notNull(),action:text('action').notNull(),
 idempotencyKey:text('idempotency_key').notNull(),requestDigest:text('request_digest').notNull(),token:text('token').notNull().unique(),status:text('status').notNull(),
 workspaceRevision:integer('workspace_revision').notNull(),authorizationRevision:integer('authorization_revision').notNull(),writerEpoch:integer('writer_epoch').notNull(),recoveryEpoch:integer('recovery_epoch').notNull(),
 result:text('result').notNull().default('{}'),createdAt:text('created_at').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.commandId]}),uniqueIndex('r1_command_intent').on(t.tenantId,t.actorId,t.action,t.idempotencyKey)]);
export const r1Outbox=sqliteTable('r1_outbox',{
 tenantId:text('tenant_id').notNull(),eventId:text('event_id').notNull(),commandId:text('command_id').notNull(),eventType:text('event_type').notNull(),workspaceRevision:integer('workspace_revision').notNull(),payload:text('payload').notNull(),status:text('status').notNull().default('pending'),
},t=>[primaryKey({columns:[t.tenantId,t.eventId]}),foreignKey({columns:[t.tenantId,t.commandId],foreignColumns:[r1Commands.tenantId,r1Commands.commandId]})]);
export const r1RecoveryChanges=sqliteTable('r1_recovery_changes',{
 seq:integer('seq').primaryKey({autoIncrement:true}),tenantId:text('tenant_id').notNull(),txId:text('tx_id').notNull(),tableName:text('table_name').notNull(),rowKey:text('row_key').notNull(),operation:text('operation').notNull(),afterImage:text('after_image'),schemaVersion:integer('schema_version').notNull(),workspaceRevision:integer('workspace_revision').notNull(),
},t=>[index('r1_recovery_tenant_seq').on(t.tenantId,t.seq)]);
export const r1PermissionGrants=sqliteTable('r1_permission_grants',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),memberId:text('member_id').notNull(),objectType:text('object_type').notNull(),action:text('action').notNull(),relationType:text('relation_type').notNull(),scope:text('scope').notNull(),fields:text('fields').notNull(),historyMode:text('history_mode').notNull(),validFrom:text('valid_from').notNull(),validTo:text('valid_to'),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),index('r1_grants_member_action').on(t.tenantId,t.memberId,t.objectType,t.action)]);
export const r1Relationships=sqliteTable('r1_relationships',{
 tenantId:text('tenant_id').notNull().references(()=>workspaces.owner),id:text('id').notNull(),managerPersonId:text('manager_person_id').notNull(),subjectPersonId:text('subject_person_id').notNull(),relationType:text('relation_type').notNull(),validFrom:text('valid_from').notNull(),validTo:text('valid_to'),sourceVersion:text('source_version').notNull(),
},t=>[primaryKey({columns:[t.tenantId,t.id]}),index('r1_relationship_subject').on(t.tenantId,t.managerPersonId,t.subjectPersonId)]);
