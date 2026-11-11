/** F-326 S3，设计 §7 AC-04/05/07/09/19/20/28。全部经 createApp 与租户事务。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as approvalContext from '../../apps/api/src/modules/approval/context.js';
import { addMember, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { hrApi, memberWithAdminRole } from './AC-PRM-users-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BASE = '/api/tenant/approval/matrices';
type Column = {
  id?: string;
  key: string;
  kind: 'condition' | 'role';
  dimension?: 'department' | 'position' | 'job' | null;
  includeChildren: boolean;
  name: string;
  allowMultiple: boolean;
};
type InputRow = { id?: string; cells: Record<string, string[]> };
type Structure = { columns: Column[]; rows: InputRow[] };
interface Matrix {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  columns: (Omit<Column, 'key'> & { id: string; seq: number })[];
  rows: { id: string; seq: number; cells: Record<string, string[]> }[];
}
const role = (key = 'r1'): Column => ({
  key,
  kind: 'role',
  name: key,
  includeChildren: false,
  allowMultiple: true,
});
const condition = (key = 'c1'): Column => ({
  key,
  kind: 'condition',
  dimension: 'department',
  name: key,
  includeChildren: true,
  allowMultiple: false,
});
const basic = (): Structure => ({
  columns: [condition(), role()],
  rows: [{ cells: { c1: [randomUUID()], r1: [randomUUID()] } }],
});
const inputOf = (m: Matrix): Structure => ({
  columns: m.columns.map(({ seq: _seq, ...column }, i) => ({ ...column, key: `c${i}` })),
  rows: m.rows.map((row) => ({
    id: row.id,
    cells: Object.fromEntries(m.columns.map((column, i) => [`c${i}`, row.cells[column.id] ?? []])),
  })),
});
const state = (m: Matrix) => ({ columns: m.columns, rows: m.rows, revision: m.revision });
const entries = (m: Matrix) =>
  Object.fromEntries([
    ...m.columns.map(({ id, ...value }) => [`column:${id}`, value]),
    ...m.rows.map(({ id, ...value }) => [`row:${id}`, value]),
  ]);

describe('审批矩阵管理与结构审计', () => {
  let w: PermissionWorld;
  let api: ReturnType<typeof tenantApi>;
  beforeAll(async () => {
    w = await seedPermissionWorld(database().db);
    api = tenantApi(w.db, { authorize: undefined });
  });
  async function json<T>(response: Response, expected = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(expected);
    return response.json() as Promise<T>;
  }
  const request = (method: string, path: string, body?: unknown, key?: string) =>
    api.request(method, path, { ...w.asAdmin, body, idempotencyKey: key });
  const create = async (over = {}) => json<Matrix>(await requestResult(over), 201);
  function requestResult(over: Record<string, unknown>) {
    // 返回 Promise 的装配留在 create，避免跳过真实中间件。
    return request('POST', BASE, { code: `M${uniqueSuffix()}`, name: '合成矩阵', ...over });
  }
  const read = async (id: string) => json<Matrix>(await request('GET', `${BASE}/${id}`));
  const save = async (m: Matrix, input: Structure, key?: string) =>
    json<Matrix>(await request('PUT', `${BASE}/${m.id}/structure`, { revision: m.revision, ...input }, key));
  async function rejectStructure(m: Matrix, input: unknown, reason?: string) {
    const before = await read(m.id);
    const body = await json<{ error: { code: string; details: { reason: string } } }>(
      await request('PUT', `${BASE}/${m.id}/structure`, { revision: m.revision, ...(input as object) }),
      400,
    );
    expect(body.error.code).toBe('VALIDATION_FAILED');
    if (reason) expect(body.error.details.reason).toBe(reason);
    expect(state(await read(m.id))).toEqual(state(before));
  }
  async function audits(id: string) {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT action,object_id AS "objectId",before,after,command_id AS "commandId"
        FROM audit_events WHERE tenant_id=${w.tenant.id} AND object_id=${id}
        AND action LIKE 'approval.matrix.%' ORDER BY occurred_at,id`);
      return approvalContext.rowsOf(result) as {
        action: string;
        objectId: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        commandId: string;
      }[];
    });
  }

  it('AC-04：头部、草稿→启用→停用→启用，三态可编辑，编码只读，无删除', async () => {
    let m = await create();
    expect(m).toMatchObject({ status: 'draft', revision: 1, createdBy: w.admin.id, updatedBy: w.admin.id });
    expect(m.columns).toEqual([]);
    expect(m.rows).toEqual([]);
    expect((await request('POST', `${BASE}/${m.id}/disable`, { revision: m.revision })).status).toBe(409);
    for (const action of ['enable', 'disable', 'enable']) {
      m = await json<Matrix>(await request('PATCH', `${BASE}/${m.id}`, { revision: m.revision, name: action }));
      m = await json<Matrix>(await request('POST', `${BASE}/${m.id}/${action}`, { revision: m.revision }));
      expect(m.status).toBe(action === 'enable' ? 'enabled' : 'disabled');
    }
    const before = await read(m.id);
    expect((await request('PATCH', `${BASE}/${m.id}`, { revision: m.revision, code: 'Changed' })).status).toBe(400);
    expect(await read(m.id)).toEqual(before);
    expect((await request('DELETE', `${BASE}/${m.id}`, { revision: m.revision })).status).toBe(404);
    const enabled = await create({ enable: true });
    expect(enabled.status).toBe('enabled');
    expect((await audits(enabled.id)).map((a) => a.action).sort()).toEqual([
      'approval.matrix.create',
      'approval.matrix.enable',
    ]);
  });

  it('AC-04：列表草稿与启用归 active，停用单列，关键字及分页', async () => {
    const code = `L${uniqueSuffix()}`;
    const draft = await create({ code, name: '分页检索_合成' });
    let other = await create({ name: '分页检索_合成', enable: true });
    other = await json<Matrix>(await request('POST', `${BASE}/${other.id}/disable`, { revision: other.revision }));
    const active = await json<{ items: Matrix[] }>(await request('GET', `${BASE}?status=active&q=${code}&limit=1`));
    expect(active.items.map((x) => x.id)).toEqual([draft.id]);
    const disabled = await json<{ items: Matrix[] }>(await request('GET', `${BASE}?status=disabled&q=${other.code}`));
    expect(disabled.items.map((x) => x.id)).toEqual([other.id]);
    expect((await request('GET', `${BASE}?limit=201`)).status).toBe(400);
    expect((await request('POST', BASE, { code, name: '重复编码' })).status).toBe(409);
  });

  it('AC-05：每个写出口同键重放、异内容冲突，409 后重读并改回原值', async () => {
    const key = randomUUID();
    const body = { code: `I${uniqueSuffix()}`, name: '原名称' };
    let m = await json<Matrix>(await request('POST', BASE, body, key), 201);
    expect(await json(await request('POST', BASE, body, key), 201)).toEqual(m);
    expect((await request('POST', BASE, { ...body, name: '另一个' }, key)).status).toBe(409);
    const writes = [
      { method: 'PATCH', path: '', input: { name: '新名称' } },
      { method: 'PUT', path: '/structure', input: basic() },
      { method: 'POST', path: '/enable', input: {} },
      { method: 'POST', path: '/disable', input: {} },
    ];
    for (const write of writes) {
      const command = randomUUID();
      const payload = { revision: m.revision, ...write.input };
      const path = `${BASE}/${m.id}${write.path}`;
      m = await json<Matrix>(await request(write.method, path, payload, command));
      expect(await json(await request(write.method, path, payload, command))).toEqual(m);
      expect((await request(write.method, path, { ...payload, revision: 999 }, command)).status).toBe(409);
      expect((await request(write.method, path, payload)).status).toBe(409);
      expect(await read(m.id)).toEqual(m);
    }
    m = await read(m.id);
    m = await json<Matrix>(await request('PATCH', `${BASE}/${m.id}`, { revision: m.revision, name: '原名称' }));
    expect(m.name).toBe('原名称');
  });

  it('AC-07：三类管理员可用，普通成员全部接口 403，跨租户 404', async () => {
    const m = await create();
    for (const roleName of ['system_admin', 'matrix_admin'] as const) {
      const member = await memberWithAdminRole(w, roleName);
      expect((await api.request('GET', BASE, member.as)).status).toBe(200);
      expect(
        (await api.request('POST', BASE, { ...member.as, body: { code: `R${uniqueSuffix()}`, name: '角色矩阵' } }))
          .status,
      ).toBe(201);
    }
    const member = await addMember(w, 'matrix-member');
    const as = { user: member.id, tenant: w.tenant.id };
    for (const [method, path, body] of [
      ['GET', BASE, undefined],
      ['GET', `${BASE}/${m.id}`, undefined],
      ['POST', BASE, { code: 'Forbidden', name: '拒绝' }],
      ['PATCH', `${BASE}/${m.id}`, { revision: 1, name: '拒绝' }],
      ['PUT', `${BASE}/${m.id}/structure`, { revision: 1, ...basic() }],
      ['POST', `${BASE}/${m.id}/enable`, { revision: 1 }],
      ['POST', `${BASE}/${m.id}/disable`, { revision: 1 }],
    ] as const)
      expect((await api.request(method, path, { ...as, body })).status, path).toBe(403);
    const other = await seedPermissionWorld(w.db);
    expect((await api.request('GET', `${BASE}/${m.id}`, other.asAdmin)).status).toBe(404);
    expect(
      (
        await api.request('PATCH', `${BASE}/${m.id}`, {
          ...other.asAdmin,
          body: { revision: 1, name: '越租户' },
        })
      ).status,
    ).toBe(404);
    expect(await read(m.id)).toEqual(m);
  });

  it('AC-09：整单保存、稳定 ID、UUID 小写、行列调序、删列清格', async () => {
    let m = await create();
    const input = basic();
    input.rows.push({ cells: {} });
    input.rows[0]!.cells.r1 = [w.admin.id.toUpperCase()];
    m = await save(m, input);
    expect(m.rows[0]!.cells[m.columns[1]!.id]).toEqual([w.admin.id]);
    const before = m;
    const next = inputOf(m);
    next.rows.reverse();
    next.columns.reverse();
    m = await save(m, next);
    expect(m.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id).reverse());
    expect(m.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(m.columns.map((c) => c.id)).toEqual(before.columns.map((c) => c.id).reverse());
    m = await save(m, { columns: [], rows: [] });
    expect(m.rows).toEqual([]);
    expect(m.columns).toEqual([]);
  });

  it('AC-07/09：详情名称按租户回显，人员只有姓名、工号、部门', async () => {
    const hr = hrApi(w);
    const departmentId = await hr.org('合成矩阵部门');
    const person = await hr.employee('合成矩阵人员', `matrix-${uniqueSuffix()}@example.com`);
    expect((await hr.hire(person, departmentId)).status).toBe(201);
    const userId = await withTenant(w.db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT user_id FROM permission_user_person_links
        WHERE tenant_id=${w.tenant.id} AND employee_id=${person.id}`);
      return String(approvalContext.rowsOf(result)[0]!.user_id);
    });
    const m = await save(await create(), {
      columns: [condition(), role()],
      rows: [{ cells: { c1: [departmentId], r1: [userId] } }],
    });
    const detail = await json<{ referenceNames: Record<string, Record<string, unknown>> }>(
      await request('GET', `${BASE}/${m.id}`),
    );
    expect(detail.referenceNames.department![departmentId]).toBe('合成矩阵部门');
    expect(detail.referenceNames.person![userId]).toEqual({
      userId,
      name: '合成矩阵人员',
      code: person.code,
      departmentId,
      departmentName: '合成矩阵部门',
    });
  });

  it('AC-05/07：命令重放按当前管理员能力复核，拒绝时业务和审计不变', async () => {
    let allowed = true;
    const guarded = tenantApi(w.db, { authorize: ({ action }) => action !== 'admin.process_matrix' || allowed });
    const m = await create();
    const key = randomUUID();
    const options = { ...w.asAdmin, idempotencyKey: key, body: { revision: m.revision, name: '重放合成矩阵' } };
    const result = await json<Matrix>(await guarded.request('PATCH', `${BASE}/${m.id}`, options));
    const beforeAudits = await audits(m.id);
    allowed = false;
    expect((await guarded.request('PATCH', `${BASE}/${m.id}`, options)).status).toBe(403);
    expect(await read(m.id)).toEqual(result);
    expect(await audits(m.id)).toEqual(beforeAudits);
  });

  it('AC-09：结构外来 ID、重复 ID 与换名调序的合法候选态', async () => {
    const m = await save(await create(), basic());
    const same = inputOf(m);
    same.rows.push(structuredClone(same.rows[0]!));
    await rejectStructure(m, same);
    const duplicateColumn = inputOf(m);
    duplicateColumn.columns.push({ ...duplicateColumn.columns[0]!, key: 'othr', name: '另一个名称' });
    await rejectStructure(m, duplicateColumn);
    const renamed = inputOf(m);
    [renamed.columns[0]!.name, renamed.columns[1]!.name] = [renamed.columns[1]!.name, renamed.columns[0]!.name];
    const saved = await save(m, renamed);
    expect(saved.columns.map((c) => c.name)).toEqual(m.columns.map((c) => c.name).reverse());
  });

  it('AC-09/19：结构写到审计时失败，行列、revision、台账、outbox 一起回滚', async () => {
    const m = await save(await create(), basic());
    const prior = await audits(m.id);
    const commandId = randomUUID();
    const original = approvalContext.auditApproval;
    const injected = vi.spyOn(approvalContext, 'auditApproval').mockImplementation(async (tx, ctx, entry) => {
      if (entry.action === 'approval.matrix.structure')
        throw Object.assign(new Error('合成审计存储失败'), { code: '53100' });
      await original(tx, ctx, entry);
    });
    try {
      const response = await request(
        'PUT',
        `${BASE}/${m.id}/structure`,
        {
          revision: m.revision,
          columns: [],
          rows: [],
        },
        commandId,
      );
      expect(response.status).toBe(503);
    } finally {
      injected.mockRestore();
    }
    expect(await read(m.id)).toEqual(m);
    expect(await audits(m.id)).toEqual(prior);
    await withTenant(w.db, w.tenant.id, async (tx) => {
      for (const table of ['command_ledger', 'approval_outbox']) {
        const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}
          WHERE tenant_id=${w.tenant.id} AND command_id=${commandId}`);
        expect(approvalContext.rowsOf(result)[0]).toEqual({ n: 0 });
      }
    });
  });

  it('AC-28：头部名称和描述边界、合法配对字符、控制字符及未知字段', async () => {
    const m = await create({ name: '中'.repeat(98) + '😀', description: '中'.repeat(255) });
    for (const input of [
      { name: '中'.repeat(101) },
      { description: '中'.repeat(256) },
      { name: '\t名称' },
      { description: '\u0000' },
      { name: '\uD800' },
      { updatedBy: randomUUID() },
    ]) {
      expect((await request('PATCH', `${BASE}/${m.id}`, { revision: m.revision, ...input })).status).toBe(400);
      expect(await read(m.id)).toEqual(m);
    }
    const updated = await json<Matrix>(
      await request('PATCH', `${BASE}/${m.id}`, {
        revision: m.revision,
        description: '说明\t换行\n回车\r😀',
      }),
    );
    expect(updated.description).toBe('说明\t换行\n回车\r😀');
  });

  it.runIf(!!process.env.TEST_DATABASE_URL)('AC-05：真 PG 两连接竞争同一 revision 只提交一次结构与审计', async () => {
    const m = await create();
    const inputs = [basic(), basic()];
    const responses = await Promise.all(
      inputs.map((input) =>
        request('PUT', `${BASE}/${m.id}/structure`, {
          revision: m.revision,
          ...input,
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winning = responses.findIndex((r) => r.status === 200);
    const saved = await read(m.id);
    expect(saved.revision).toBe(m.revision + 1);
    expect(saved.rows[0]!.cells[saved.columns[0]!.id]).toEqual(inputs[winning]!.rows[0]!.cells.c1);
    expect((await audits(m.id)).filter((a) => a.action === 'approval.matrix.structure')).toHaveLength(1);
  });

  it.each([
    ['条件列', { columns: Array.from({ length: 6 }, (_, i) => condition(`c${i}`)), rows: [] }],
    ['角色列', { columns: Array.from({ length: 11 }, (_, i) => role(`r${i}`)), rows: [] }],
    ['行', { columns: [], rows: Array.from({ length: 501 }, () => ({ cells: {} })) }],
    ['列名', { columns: [{ ...role(), name: '中'.repeat(51) }], rows: [] }],
    ['条件格', { columns: [condition()], rows: [{ cells: { c1: Array.from({ length: 51 }, () => randomUUID()) } }] }],
    ['角色格', { columns: [role()], rows: [{ cells: { r1: Array.from({ length: 101 }, () => randomUUID()) } }] }],
  ])('AC-09：%s 超一整体拒绝', async (_label, input) => {
    const m = await save(await create(), basic());
    await rejectStructure(m, input);
  });

  it('AC-09/28：非法文本、重复身份、短键与列格对应错误均不部分写入', async () => {
    const m = await save(await create(), basic());
    for (const [name, reason] of [
      ['坏\uD800', 'TEXT_MALFORMED'],
      ['坏\u0001', 'TEXT_CONTROL_CHAR'],
    ]) {
      await rejectStructure(m, { columns: [{ ...role(), name }], rows: [] }, reason);
    }
    for (const input of [
      { columns: [role('invalid')], rows: [] },
      { columns: [role(), role()], rows: [] },
      { columns: [role()], rows: [{ cells: { missing: [] } }] },
      { columns: [{ ...role(), allowMultiple: false }], rows: [{ cells: { r1: [randomUUID(), randomUUID()] } }] },
      { columns: [{ ...role(), id: randomUUID() }], rows: [] },
      { columns: [], rows: [{ id: randomUUID(), cells: {} }] },
    ])
      await rejectStructure(m, input);
    const malformed = await request('PATCH', `${BASE}/${m.id}`, { revision: m.revision, name: '坏\uDC00' });
    expect(malformed.status).toBe(400);
    expect(await read(m.id)).toEqual(m);
  });

  it('AC-19：整行差异、批删三行快照、用审计完整重建删除前结构', async () => {
    const input = basic();
    input.rows = Array.from({ length: 3 }, () => structuredClone(input.rows[0]!));
    let m = await save(await create(), input);
    const beforeEdit = m;
    const changed = inputOf(m);
    const department = randomUUID();
    const person = randomUUID();
    changed.rows[0]!.cells = { c0: [department], c1: [person] };
    m = await save(m, changed);
    const edit = (await audits(m.id)).find(
      (a) =>
        a.action === 'approval.matrix.structure' && (a.before?.[`row:${m.rows[0]!.id}`] as { seq?: number })?.seq === 1,
    )!;
    expect(edit.before[`row:${m.rows[0]!.id}`]).toEqual({ seq: 1, cells: beforeEdit.rows[0]!.cells });
    expect(edit.after[`row:${m.rows[0]!.id}`]).toEqual({ seq: 1, cells: m.rows[0]!.cells });
    const beforeDelete = m;
    const key = randomUUID();
    m = await save(m, { columns: [], rows: [] }, key);
    const deletion = (await audits(m.id)).find((a) => a.commandId === key)!;
    const rebuilt = entries(m);
    for (const [entry, value] of Object.entries(deletion.before)) {
      if (value === null) delete rebuilt[entry];
      else rebuilt[entry] = value;
    }
    expect(rebuilt).toEqual(entries(beforeDelete));
    for (const row of beforeDelete.rows) {
      const deleted = (await audits(row.id)).filter((a) => a.action === 'approval.matrix.row.delete');
      expect(deleted).toHaveLength(1);
      expect(deleted[0]!.before).toEqual({
        matrixId: m.id,
        matrixCode: m.code,
        seq: row.seq,
        cells: row.cells,
        columns: Object.fromEntries(beforeDelete.columns.map((c) => [c.id, { name: c.name, kind: c.kind }])),
      });
      expect(deleted[0]!.after).toBeNull();
    }
  });

  it('AC-20：最坏合法 500×15、20000 ID、50 字列名成功，超量与字节上限保持原结构', async () => {
    let m = await create();
    const columns = [
      ...Array.from({ length: 5 }, (_, i) => condition(`c${i}00`)),
      ...Array.from({ length: 10 }, (_, i) => role(`r${i}00`)),
    ].map((c, i) => ({ ...c, name: `${i}`.padEnd(50, '中') }));
    const ids = Array.from({ length: 40 }, () => randomUUID());
    const rows = Array.from({ length: 500 }, () => ({
      cells: Object.fromEntries(columns.map((c, i) => [c.key, i === 0 ? ids : []])),
    }));
    // 先落库再携带全部稳定行列 ID，覆盖设计中最大的行骨架。
    m = await save(m, { columns, rows });
    const worst = inputOf(m);
    worst.columns = worst.columns.map((c, i) => ({ ...c, key: columns[i]!.key }));
    worst.rows = m.rows.map((r) => ({ id: r.id, cells: structuredClone(rows[0]!.cells) }));
    const payload = { revision: m.revision, ...worst };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    expect(bytes).toBeGreaterThan(850000);
    expect(bytes).toBeLessThan(1048576);
    const started = performance.now();
    m = await save(m, worst);
    console.info(`AC-20 最坏结构 ${bytes} 字节，保存 ${Math.round(performance.now() - started)} 毫秒`);
    const tooMany = structuredClone(worst);
    tooMany.rows[0]!.cells.c000!.push(randomUUID());
    await rejectStructure(m, tooMany);
    await rejectStructure(m, { columns: [], rows: Array.from({ length: 501 }, () => ({ cells: {} })) });
    for (const [method, path, max] of [
      ['PUT', `${BASE}/${m.id}/structure`, 1048576],
      ['POST', BASE, 32768],
      ['PATCH', `${BASE}/${m.id}`, 32768],
      ['POST', `${BASE}/${m.id}/enable`, 32768],
      ['POST', `${BASE}/${m.id}/disable`, 32768],
    ] as const) {
      // JSON 字符串两边引号正好两字节，真实请求体为 max+1。
      const res = await request(method, path, 'x'.repeat(max - 1));
      expect(res.status, path).toBe(413);
      expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
      expect(state(await read(m.id))).toEqual(state(m));
    }
  }, 120000);
});
