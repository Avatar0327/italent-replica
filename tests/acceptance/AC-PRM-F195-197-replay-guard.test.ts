/**
 * F-195 / F-197 重放权限复核（DEC-555，DEC-406 权限类后补；#362 第 1 轮 P2-4、#367 第 1 轮 P2-3）：
 * 编辑离职 / 退休记录的三条路径（记录编辑 PATCH /records/:id、批量编辑、导入编辑行）与待入职行内编辑
 * PATCH /pending-entries/:id，首次成功后撤权，同键同内容重放必须按当前权限被拒，不再返回台账里的原 200。
 *
 * 撤权模型：请求入口的复核（事务外）仍放行，撤权“落在入口复核之后、命令事务之内”——授权提供器只在带事务的调用里
 * 拒绝（authorizeInTransaction 绑定的授权器 / 事务内解析的数据范围）。这样旧实现（命令内才复核、重放直接返回台账）
 * 按行为失败，而不是因为入口复核恰好拦住而侥幸通过。
 * 被拒时业务、字段级审计（audit_events）、命令台账与版本链都不变；失败本身另记的 audit_command_failures 是
 * 确定业务失败的失败记录（AGENTS.md §10「审计」），不属于业务审计，不比较。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { addPending, businessRevision, entryWorld } from './AC-EN-BE2a-support.js';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
const TODAY = '2026-10-06';
const clock = () => new Date(`${TODAY}T01:00:00.000Z`);
// 最后工作日已过的直接离职立即生效，才有可编辑的有效离职记录；造数走可信端口（不经离职创建门禁，本单只测编辑重放）
const LAST_WORK_DAY = '2026-10-01';

type Request = Parameters<Authorizer>[0];
const isButton = (code: string) => (request: Request) =>
  request.action === 'object.button' && String(request.resource).includes(`#${code}@`);
const deniesObjectUpdate = (request: Request) =>
  request.action === 'object.update' && (request.fields?.length ?? 0) === 0;
const deniesFieldWrite = (field: string) => (request: Request) =>
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
function revocable() {
  const rights: { deny?: (request: Request) => boolean; emptyScope?: boolean } = {};
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (_query, tx) =>
      tx && rights.emptyScope ? EMPTY_SCOPE : { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
    authorize: async (request, tx) => !(tx && rights.deny?.(request)),
    fields: async () => FIELDS,
  });
  return { rights, authorize };
}

type Revoker = readonly [name: string, apply: (rights: ReturnType<typeof revocable>['rights']) => void];
const revoke = (deny: (request: Request) => boolean): Revoker['1'] => {
  return (rights) => {
    rights.deny = deny;
  };
};
const emptyScope: Revoker['1'] = (rights) => {
  rights.emptyScope = true;
};

/** 业务、审计、台账三类状态的快照（被拒后逐项相等）。 */
async function snapshot(db: Parameters<typeof withTenant>[0], tenantId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`SELECT
        (SELECT count(*) FROM audit_events WHERE tenant_id=${tenantId}) AS audits,
        (SELECT count(*) FROM command_ledger WHERE tenant_id=${tenantId}) AS ledger,
        (SELECT count(*) FROM employment_payload_versions WHERE tenant_id=${tenantId}) AS versions,
        (SELECT string_agg(id::text || ':' || revision, ',' ORDER BY id) FROM employment_business_objects
          WHERE tenant_id=${tenantId}) AS revisions`),
    );
    return row;
  });
}

// ---- 离职记录的三条编辑路径 -------------------------------------------------------------------------------------

async function exitWorld(label: string) {
  const w = await gateWorld(database().db, label, { today: TODAY });
  const { employee } = await w.hired();
  const leave = await w.createdLeave(employee.id, leaveBody(LAST_WORK_DAY, 'direct'));
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const call = (method: string, path: string, init: { ifMatch?: number; body?: object; key: string }) =>
    api.request(method, `${BASE}${path}`, {
      ...w.as,
      ifMatch: init.ifMatch,
      idempotencyKey: init.key,
      ...(init.body ? { body: init.body } : {}),
    });
  return { w, employee, leave, rights, call };
}
type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;

interface Revisions {
  readonly business: number;
  readonly employee: number;
}

interface EditPath {
  readonly name: string;
  /** 以给定幂等键发起一次该路径的编辑（每次调用的 If-Match / 请求体相同，才算同键同内容）。 */
  readonly send: (x: ExitWorld, key: string, revisions: Revisions) => Promise<Response>;
}

const PATCH_BODY = { fields: { place: '重放复核地点' } };
const PATHS: readonly EditPath[] = [
  {
    name: '记录编辑 PATCH /records/:id',
    send: (x, key, revisions) =>
      x.call('PATCH', `/records/${x.leave.id}`, { ifMatch: revisions.business, body: PATCH_BODY, key }),
  },
  {
    name: '批量编辑 POST /records/batch-edit',
    send: (x, key, revisions) =>
      x.call('POST', '/records/batch-edit', {
        key,
        body: { items: [{ id: x.leave.id, revision: revisions.business }], patch: PATCH_BODY },
      }),
  },
  {
    name: '导入编辑 POST /employees/:id/import',
    send: (x, key, revisions) =>
      x.call('POST', `/employees/${x.employee.id}/import`, {
        ifMatch: revisions.employee,
        key,
        body: { items: [{ operation: 'edit', id: x.leave.id, revision: revisions.business, patch: PATCH_BODY }] },
      }),
  },
];

const EXIT_REVOKERS: readonly Revoker[] = [
  ['撤掉 DimissionEdit 按钮', revoke(isButton('Employment.DimissionEdit'))],
  ['撤掉对象编辑权', revoke(deniesObjectUpdate)],
  ['数据范围收为空', emptyScope],
];

/** 首次成功 → 返回台账里的原回执，后续重放以这份为对照。 */
async function firstEdit(x: ExitWorld, path: EditPath, key: string) {
  const revisions = await currentRevisions(x);
  const first = await path.send(x, key, revisions);
  expect(first.status, await first.clone().text()).toBe(200);
  return { revisions, first };
}

/** 重放必须带首次的 If-Match / 请求体（指纹含前置 revision），所以版本号在首次之前取一次。 */
async function currentRevisions(x: ExitWorld): Promise<Revisions> {
  const response = await x.w.session.request('GET', `/businesses/${x.leave.id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const employee = await x.w.session.getEmployee(x.employee.id);
  return { business: ((await response.json()) as { revision: number }).revision, employee: employee.revision };
}

describe.each(PATHS)('F-195 离职记录的$name', (path) => {
  it.each(EXIT_REVOKERS)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (_name, apply) => {
    const x = await exitWorld(`f195-${path.name.length}-${_name.length}`);
    const key = randomUUID();
    const { revisions } = await firstEdit(x, path, key);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const replay = await path.send(x, key, revisions);
    // 无权限 403；数据范围收为空与“对象不存在”同一个 404（不泄露存在性）
    expect([403, 404], await replay.clone().text()).toContain(replay.status);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it('对照：权限不变时同键重放返回原响应，不重复写入', async () => {
    const x = await exitWorld(`f195-same-${path.name.length}`);
    const key = randomUUID();
    const { revisions, first } = await firstEdit(x, path, key);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    const replay = await path.send(x, key, revisions);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it('首次执行：入口放行但命令内已无 DimissionEdit → 403，无任何写入（前移后首次结果不变）', async () => {
    const x = await exitWorld(`f195-first-${path.name.length}`);
    const revisions = await currentRevisions(x);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    x.rights.deny = isButton('Employment.DimissionEdit');
    const response = await path.send(x, randomUUID(), revisions);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });
});

// ---- F-197 待入职行内编辑 ---------------------------------------------------------------------------------------

async function pendingWorld(label: string) {
  const w = await entryWorld(database().db, label);
  const { recordId } = await addPending(w, '2026-10-10');
  const { authorize, rights } = revocable();
  const api = tenantApi(w.db, { authorize, clock });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  const patch = (ifMatch: number, key: string, body: object) =>
    api.request('PATCH', `${BASE}/pending-entries/${recordId}`, { ...as, ifMatch, idempotencyKey: key, body });
  return { w, recordId, rights, patch };
}

const EDIT_BODY = { effectiveDate: '2026-10-12', probation: true };
const PENDING_REVOKERS: readonly Revoker[] = [
  ['撤掉任职记录对象编辑权', revoke(deniesObjectUpdate)],
  ['撤掉 Employment.Edit 按钮', revoke(isButton('Employment.Edit'))],
  ['撤掉入职日期字段写权限', revoke(deniesFieldWrite('effectiveDate'))],
  ['数据范围收为空', emptyScope],
];

async function editedOnce(label: string) {
  const x = await pendingWorld(label);
  const revision = await businessRevision(x.w, x.recordId);
  const key = randomUUID();
  const first = await x.patch(revision, key, EDIT_BODY);
  expect(first.status, await first.clone().text()).toBe(200);
  return { ...x, revision, key, first };
}

describe('F-197 PATCH /pending-entries/:id 同键重放按当前权限复核', () => {
  it.each(PENDING_REVOKERS)('首次成功后%s：同键同内容重放被拒，业务 / 审计 / 台账不变', async (_name, apply) => {
    const x = await editedOnce(`f197-${_name.length}`);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const replay = await x.patch(x.revision, x.key, EDIT_BODY);
    expect([403, 404], await replay.clone().text()).toContain(replay.status);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it('对照：权限不变时同键重放返回原响应，不重复写入', async () => {
    const x = await editedOnce('f197-same');
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    const replay = await x.patch(x.revision, x.key, EDIT_BODY);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(await x.first.json());
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });

  it.each(PENDING_REVOKERS)('首次执行：命令内已%s → 拒绝，无任何写入', async (_name, apply) => {
    const x = await pendingWorld(`f197-first-${_name.length}`);
    const revision = await businessRevision(x.w, x.recordId);
    const before = await snapshot(x.w.db, x.w.session.tenant.id);
    apply(x.rights);
    const response = await x.patch(revision, randomUUID(), EDIT_BODY);
    expect([403, 404], await response.clone().text()).toContain(response.status);
    expect(await snapshot(x.w.db, x.w.session.tenant.id)).toEqual(before);
  });
});
