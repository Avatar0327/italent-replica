/**
 * 重放权限复核（F-195 / F-197）验收共用：可中途撤权的授权器、撤权方式与业务 / 审计 / 台账快照。
 * 撤权模型见 AC-PRM-F195-197-replay-guard.test.ts 文件头。
 */
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { rowsOf } from '../../../apps/api/src/modules/employment/record-store.js';
import { registerScopeProvider } from '../../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../../apps/api/src/modules/permission/scope-types.js';

export type Request = Parameters<Authorizer>[0];
export const isButton = (code: string) => (request: Request) =>
  request.action === 'object.button' && String(request.resource).includes(`#${code}@`);
export const deniesObjectUpdate = (request: Request) =>
  request.action === 'object.update' && (request.fields?.length ?? 0) === 0;
export const deniesFieldWrite = (field: string) => (request: Request) =>
  request.action === 'object.update' && (request.fields ?? []).includes(field);

const FIELDS = new Set<string>([
  ...[MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.employee, MODULE_OBJECTS.employmentSettings].flatMap((object) =>
    object.fields.map((field) => field.code),
  ),
  'id',
  'revision',
]);

/**
 * 可中途撤权的授权器。入口（事务外）的授权器调用一律放行；带事务的调用——命令内的权限复核、事务内解析的数据范围——
 * 才应用 `rights`。所以先让首次执行成功（rights 为空），再设置 rights 模拟“撤权发生在入口复核之后”。
 */
export function revocable() {
  const rights: { deny?: (request: Request) => boolean; emptyScope?: boolean; scope?: ModuleScope } = {};
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (_query, tx) => {
      if (tx && rights.scope) return rights.scope;
      return tx && rights.emptyScope ? EMPTY_SCOPE : { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
    },
    authorize: async (request, tx) => !(tx && rights.deny?.(request)),
    fields: async () => FIELDS,
  });
  return { rights, authorize };
}

export type Revoker = readonly [name: string, apply: (rights: ReturnType<typeof revocable>['rights']) => void];
export const revoke = (deny: (request: Request) => boolean): Revoker['1'] => {
  return (rights) => {
    rights.deny = deny;
  };
};
export const emptyScope: Revoker['1'] = (rights) => {
  rights.emptyScope = true;
};

/** 业务、审计、台账三类状态的快照（被拒后逐项相等）。 */
export async function snapshot(db: Parameters<typeof withTenant>[0], tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT
        (SELECT count(*) FROM audit_events WHERE tenant_id=${tenantId}) AS audits,
        (SELECT count(*) FROM command_ledger WHERE tenant_id=${tenantId}) AS ledger,
        (SELECT count(*) FROM employment_payload_versions WHERE tenant_id=${tenantId}) AS versions,
        (SELECT string_agg(id::text || ':' || revision, ',' ORDER BY id) FROM employment_business_objects
          WHERE tenant_id=${tenantId}) AS revisions,
        (SELECT count(*) FROM employment_state_events WHERE tenant_id=${tenantId}) AS events,
        (SELECT count(*) FROM exit_requests WHERE tenant_id=${tenantId}) AS exits`),
    );
    return row;
  });
}
