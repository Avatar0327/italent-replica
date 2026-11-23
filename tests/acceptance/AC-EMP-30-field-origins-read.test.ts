/**
 * AC-EMP-30（F-036-S5，设计 §4.9 / §7.1）：只读来源接口 `GET /businesses/:id/field-origins`
 * 的入口级错误、字段裁剪与统一 404。
 * 夹具：真实授权器下的“纯经理”——有任职对象查看权与经理入口，没有 HR 调动入口；负责 A、B 两个部门，
 * 数据范围含 A、B、范围内非团队部门，不含“范围外部门”。业务数据经真实接口创建（HR 在 allowAll 应用里建调动单），
 * 来源行用 appendFieldOrigins 追加手写的几行（它们的 seq 比创建时写入的行大，折叠后即当前来源）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { appendFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { approvalWorld, permissionAdmin, type ApprovalWorld } from './AC-APV-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BASE = '/api/tenant/employment';
const SEEDED_AT = '2026-10-01T02:03:04.000Z';
const UNIFIED_404 = { error: { code: 'NOT_FOUND', message: '任职业务不存在' } };

async function hrDraft(w: ApprovalWorld, employeeId: string, fields: object) {
  const current = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${employeeId}`),
  );
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `${BASE}/transfers/employees/${employeeId}`, {
      ifMatch: current.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'in_department',
        formId: 'TenantBase.TransferMultiFormView',
        effectiveDate: '2026-11-01',
        mode: 'application',
        fields,
      },
    }),
    201,
  );
}

interface OriginField {
  fieldCode: string;
  value: unknown;
  origin: { kind: string; sourceBusinessId: string | null } | null;
}

interface Seed {
  fieldCode: string;
  originKind: 'forward-update';
  value: string;
  sourceBusinessId: string;
}

/** 在业务当前载荷版本上追加几行来源（手写值与来源业务），模拟“向后更新”写入。 */
async function seedOrigins(w: ApprovalWorld, businessId: string, employeeId: string, rows: Seed[]) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const [version] = resultRows<{ id: string }>(
      await tx.execute(sql`SELECT id FROM employment_payload_versions
        WHERE tenant_id = ${w.tenant.id} AND business_id = ${businessId}::uuid ORDER BY version_no DESC LIMIT 1`),
    );
    const ctx = { tenantId: w.tenant.id, userId: w.hr.id, now: new Date(SEEDED_AT) };
    await appendFieldOrigins(
      tx,
      ctx,
      rows.map((row) => ({ ...row, businessId, payloadVersionId: version!.id, employeeId })),
    );
  });
}

/** 三张表的行数：来源台账、审计、命令台账。只读接口调用前后必须不变。 */
async function writeCounts(w: ApprovalWorld) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ origins: number; audits: number; commands: number }>(
      await tx.execute(sql`SELECT
        (SELECT count(*)::int FROM employment_field_origins WHERE tenant_id = ${w.tenant.id}) AS origins,
        (SELECT count(*)::int FROM audit_events WHERE tenant_id = ${w.tenant.id}) AS audits,
        (SELECT count(*)::int FROM command_ledger WHERE tenant_id = ${w.tenant.id}) AS commands`),
    );
    return row;
  });
}

/** hidden：纯经理没有这些字段的查看权（字段编码取权限对象的字段码）。 */
async function fixture(hidden: string[] = []) {
  const w = await approvalWorld(database().db, `emp30-${uniqueSuffix()}`);
  w.setNow('2026-10-01T01:00:00Z');
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const a = await w.org('负责组织 A');
  const b = await w.org('负责组织 B');
  const outside = await w.org('范围内非团队组织');
  const far = await w.org('范围外组织');
  const manager = await w.person('纯经理', a);
  const member = await w.person('团队成员', a);
  const member2 = await w.person('团队成员二', a);
  const stranger = await w.person('范围内非团队成员', outside);
  const away = await w.person('范围外员工', far);
  const bystander = await w.person('无任何权限者', a);
  await w.setOrgRoles(a, { head: manager.employeeId });
  await w.setOrgRoles(b, { head: manager.employeeId });
  const admin = await permissionAdmin(w);
  const profile = await createProfile(admin, 'department_manager_self_service');
  const definition = MODULE_OBJECTS.employmentRecord;
  const configured = await setObjectPermission(
    admin,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hidden.includes(f.code), edit: !f.system })),
      buttons: [{ buttonCode: 'Transfer.Manager', level: 'detail' as const }],
    },
    definition.code,
  );
  expect(configured.status, await configured.clone().text()).toBe(200);
  const scope = await admin.api.request('PUT', `/api/tenant/permission/scopes/${manager.userId}/TenantBase`, {
    ...admin.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [a, b, outside].map((orgId) => ({ orgId, includeDescendants: true })) },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const actor = w.as(manager.userId);
  const read = (path: string, who: { user?: string; tenant?: string } = actor) => api.request('GET', path, who);
  return { w, a, b, member, member2, stranger, away, bystander, manager, actor, read };
}

interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}
async function bodyOf(response: Response) {
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as ErrorEnvelope };
}

describe('AC-EMP-30 只读来源接口：统一 404', () => {
  it('①～④ 状态码与完整响应体逐项相等；同一夹具下详情接口对 ① 是“员工不存在”、对 ④ 是 403', async () => {
    const x = await fixture();
    const away = await hrDraft(x.w, x.away.employeeId, { departmentId: x.b });
    const stranger = await hrDraft(x.w, x.stranger.employeeId, { departmentId: x.b });
    const other = await approvalWorld(database().db, `emp30-other-${uniqueSuffix()}`);
    const otherDept = await other.org('别的租户部门');
    const foreign = await hrDraft(other, (await other.person('别租户员工', otherDept)).employeeId, {
      departmentId: otherDept,
    });
    const targets = {
      '①源员工在范围外': away.id,
      '②别的租户的业务': foreign.id,
      '③随机合法 UUID': randomUUID(),
      '④范围内非团队成员': stranger.id,
    };
    for (const [name, id] of Object.entries(targets)) {
      const { status, body } = await bodyOf(await x.read(`${BASE}/businesses/${id}/field-origins`));
      expect({ status, body }, name).toEqual({ status: 404, body: UNIFIED_404 });
      expect(body.error, name).not.toHaveProperty('details');
    }
    // 对照：详情接口不归一，仍返回 404 / 员工不存在（①）与资源级 403（④），说明新接口确实做了归一
    const detailAway = await bodyOf(await x.read(`${BASE}/businesses/${away.id}`));
    expect(detailAway.status).toBe(404);
    expect(detailAway.body.error.message).toBe('员工不存在');
    expect((await bodyOf(await x.read(`${BASE}/businesses/${stranger.id}`))).status).toBe(403);
    expect((await bodyOf(await x.read(`${BASE}/businesses/${targets['③随机合法 UUID']}`))).body).toEqual(UNIFIED_404);
  });

  it('入口级错误原样保留：未登录 401、无任职对象查看权 403、:id 不是 UUID 400，三者与详情接口完全一致', async () => {
    const x = await fixture();
    const draft = await hrDraft(x.w, x.member.employeeId, { departmentId: x.b });
    const cases = [
      { name: '未登录', who: {}, id: draft.id, status: 401 },
      { name: '无查看权', who: x.w.as(x.bystander.userId), id: draft.id, status: 403 },
      { name: '非法 id', who: x.actor, id: 'not-a-uuid', status: 400 },
    ];
    for (const { name, who, id, status } of cases) {
      const origins = await bodyOf(await x.read(`${BASE}/businesses/${id}/field-origins`, who));
      const detail = await bodyOf(await x.read(`${BASE}/businesses/${id}`, who));
      expect(origins.status, name).toBe(status);
      expect(origins, name).toEqual(detail);
    }
  });
});

describe('AC-EMP-30 只读来源接口：行内容与字段裁剪', () => {
  async function seeded(hidden: string[] = []) {
    const x = await fixture(hidden);
    const draft = await hrDraft(x.w, x.member.employeeId, { departmentId: x.b, place: 'ZZ_地点', remarks: 'ZZ_备注' });
    const visibleSource = await hrDraft(x.w, x.member2.employeeId, { departmentId: x.b });
    const hiddenSource = await hrDraft(x.w, x.away.employeeId, { departmentId: x.b });
    await seedOrigins(x.w, draft.id, x.member.employeeId, [
      { fieldCode: 'preset:place', originKind: 'forward-update', value: 'ZZ_地点', sourceBusinessId: visibleSource.id },
      {
        fieldCode: 'preset:remarks',
        originKind: 'forward-update',
        value: 'ZZ_备注',
        sourceBusinessId: hiddenSource.id,
      },
    ]);
    return { ...x, draft, visibleSource, hiddenSource };
  }

  it('有读权：200，行内容与手写期望一致；来源业务对操作人不可见时 sourceBusinessId 为 null；零写入', async () => {
    const x = await seeded();
    const before = await writeCounts(x.w);
    const response = await x.read(`${BASE}/businesses/${x.draft.id}/field-origins`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { businessId: string; contentView: unknown; fields: OriginField[] };
    expect(body.businessId).toBe(x.draft.id);
    expect(body.contentView).toEqual({ mode: 'live', instanceId: null });
    const row = (code: string) => body.fields.find((f) => f.fieldCode === code);
    expect(row('preset:place')).toEqual({
      fieldCode: 'preset:place',
      value: 'ZZ_地点',
      origin: {
        kind: 'forward-update',
        label: '向后更新',
        at: SEEDED_AT,
        sourceBusinessId: x.visibleSource.id,
        reason: null,
      },
      policy: null,
      pending: false,
      suspended: false,
    });
    expect(row('preset:remarks')).toEqual({
      fieldCode: 'preset:remarks',
      value: 'ZZ_备注',
      origin: { kind: 'forward-update', label: '向后更新', at: SEEDED_AT, sourceBusinessId: null, reason: null },
      policy: null,
      pending: false,
      suspended: false,
    });
    expect(row('preset:departmentId')).toMatchObject({
      value: x.b,
      origin: { kind: 'hr-input', sourceBusinessId: null },
    });
    // 不外露操作人、命令、被挂起行的值
    expect(JSON.stringify(body)).not.toContain(x.w.hr.id);
    expect(JSON.stringify(body)).not.toContain(x.hiddenSource.id);
    expect(await writeCounts(x.w)).toEqual(before);
  });

  it('对 place 无读权：该字段整行不返回，响应体全文搜不到字段编码、值、来源业务 ID', async () => {
    const x = await seeded(['place']);
    const response = await x.read(`${BASE}/businesses/${x.draft.id}/field-origins`);
    expect(response.status, await response.clone().text()).toBe(200);
    const text = JSON.stringify(await response.json());
    for (const leaked of ['preset:place', 'ZZ_地点', x.visibleSource.id])
      expect(text, `不应出现 ${leaked}`).not.toContain(leaked);
    expect(text).toContain('preset:remarks');
  });
});
