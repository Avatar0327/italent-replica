/**
 * AC-EMP-30（F-036-S5，设计 §4.9 / §7.1）：只读来源接口 `GET /businesses/:id/field-origins`
 * 的入口级错误、字段裁剪与统一 404。
 * 夹具：真实授权器下的“纯经理”——有任职对象查看权与经理入口，没有 HR 调动入口；负责 A、B 两个部门，
 * 数据范围含 A、B、范围内非团队部门，不含“范围外部门”。业务数据经真实接口创建（HR 在 allowAll 应用里建调动单），
 * 来源行用 appendFieldOrigins 追加手写的几行（它们的 seq 比创建时写入的行大，折叠后即当前来源）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { appendFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { approvalWorld, type ApprovalWorld } from './AC-APV-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import {
  BASE,
  UNIFIED_404,
  adjustmentOf,
  bodyOf,
  directTransfer,
  hrDraft,
  managerWorld,
  rename,
  type OriginField,
} from './AC-EMP-30-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const fixture = (hidden: string[] = []) => managerWorld(database().db, hidden);
const SEEDED_AT = '2026-10-01T02:03:04.000Z';

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

/** 来源台账、审计、命令台账、任职载荷版本（整租户与目标业务）的行数。只读接口调用前后必须不变。 */
async function writeCounts(w: ApprovalWorld, businessId?: string) {
  return withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ origins: number; audits: number; commands: number; versions: number; target: number }>(
      await tx.execute(sql`SELECT
        (SELECT count(*)::int FROM employment_field_origins WHERE tenant_id = ${w.tenant.id}) AS origins,
        (SELECT count(*)::int FROM audit_events WHERE tenant_id = ${w.tenant.id}) AS audits,
        (SELECT count(*)::int FROM command_ledger WHERE tenant_id = ${w.tenant.id}) AS commands,
        (SELECT count(*)::int FROM employment_payload_versions WHERE tenant_id = ${w.tenant.id}) AS versions,
        (SELECT count(*)::int FROM employment_payload_versions
          WHERE tenant_id = ${w.tenant.id} AND business_id = ${businessId ?? randomUUID()}::uuid) AS target`),
    );
    return row;
  });
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

describe('AC-EMP-30 只读来源接口：非法 asOf 不区分可见性', () => {
  it('?asOf=bad：范围外、范围内非团队、不存在、有权的四类请求，状态码与完整响应体逐项相等', async () => {
    const x = await fixture();
    const targets = {
      '①源员工在范围外': (await hrDraft(x.w, x.away.employeeId, { departmentId: x.far })).id,
      '②范围内非团队成员': (await hrDraft(x.w, x.stranger.employeeId, { departmentId: x.b })).id,
      '③随机合法 UUID': randomUUID(),
      '④有权读取的团队成员': (await hrDraft(x.w, x.member.employeeId, { departmentId: x.b })).id,
    };
    const expected = {
      status: 400,
      body: { error: { code: 'VALIDATION_FAILED', message: '业务日期必须为合法 YYYY-MM-DD' } },
    };
    for (const [name, id] of Object.entries(targets)) {
      const { status, body } = await bodyOf(await x.read(`${BASE}/businesses/${id}/field-origins?asOf=bad`));
      expect({ status, body }, name).toEqual(expected);
      expect(body.error, name).not.toHaveProperty('details');
    }
  });
});

describe('AC-EMP-30 只读来源接口：行内容与字段裁剪', () => {
  async function seeded(hidden: string[] = []) {
    const x = await fixture(hidden);
    const draft = await hrDraft(x.w, x.member.employeeId, { departmentId: x.b, place: 'ZZ_地点', remarks: 'ZZ_备注' });
    const visibleSource = await hrDraft(x.w, x.member2.employeeId, { departmentId: x.b });
    // 来源业务的部门与员工都在操作人范围外（DEC-177：任一在范围内即可见，所以部门也要放在范围外）
    const hiddenSource = await hrDraft(x.w, x.away.employeeId, { departmentId: x.far });
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
    const before = await writeCounts(x.w, x.draft.id);
    expect(before?.target, '目标业务已有载荷版本').toBeGreaterThan(0);
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
      // 草稿保存时台账已写下该字段的“继承”策略行；来源行（向后更新）是覆盖行，二者并存
      policy: 'inherit',
      pending: false,
      suspended: false,
    });
    expect(row('preset:remarks')).toEqual({
      fieldCode: 'preset:remarks',
      value: 'ZZ_备注',
      origin: { kind: 'forward-update', label: '向后更新', at: SEEDED_AT, sourceBusinessId: null, reason: null },
      // 草稿保存时台账已写下该字段的“继承”策略行；来源行（向后更新）是覆盖行，二者并存
      policy: 'inherit',
      pending: false,
      suspended: false,
    });
    expect(row('preset:departmentId')).toMatchObject({
      value: x.b,
      origin: { kind: 'hr-input', sourceBusinessId: null },
      policy: 'none',
    });
    // 不外露操作人、命令、被挂起行的值
    expect(JSON.stringify(body)).not.toContain(x.w.hr.id);
    expect(JSON.stringify(body)).not.toContain(x.hiddenSource.id);
    expect(await writeCounts(x.w, x.draft.id)).toEqual(before);
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

describe('AC-EMP-30 只读来源接口：来源业务 ID 按来源自身的读取门禁裁剪', () => {
  it('HR 直接调动 → 组织改名联动生成任职记录 → 纯经理读组织调整来源：调动不可读则 ID 为 null，可读则保留', async () => {
    const x = await fixture();
    const own = await directTransfer(x.w, x.member.employeeId, x.a, 'ZZ_团队内调动地点');
    const foreign = await directTransfer(x.w, x.stranger.employeeId, x.outside, 'ZZ_非团队调动地点');
    x.w.setNow('2026-10-10T01:00:00Z');
    await rename(x.w, x.a);
    await rename(x.w, x.outside);
    // 前提：经理读不到非团队成员的调动单（详情 403、来源 404），读得到团队成员的
    expect((await bodyOf(await x.read(`${BASE}/businesses/${foreign.id}`))).status).toBe(403);
    expect((await bodyOf(await x.read(`${BASE}/businesses/${foreign.id}/field-origins`))).status).toBe(404);
    expect((await x.read(`${BASE}/businesses/${own.id}`)).status).toBe(200);

    const originsOf = async (employeeId: string) => {
      const adjustment = await adjustmentOf(x.w, employeeId);
      const response = await x.read(`${BASE}/businesses/${adjustment.id}/field-origins`);
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()) as { fields: OriginField[] };
    };
    const hidden = await originsOf(x.stranger.employeeId);
    const place = hidden.fields.find((f) => f.fieldCode === 'preset:place');
    expect(place).toMatchObject({ value: 'ZZ_非团队调动地点', origin: { kind: 'copy', sourceBusinessId: null } });
    expect(JSON.stringify(hidden)).not.toContain(foreign.id);

    const visible = await originsOf(x.member.employeeId);
    expect(visible.fields.find((f) => f.fieldCode === 'preset:place')).toMatchObject({
      value: 'ZZ_团队内调动地点',
      origin: { kind: 'copy', sourceBusinessId: own.id },
    });
  });
});

describe('AC-EMP-30 只读来源接口：值与来源取同一读取快照', () => {
  const FIRST = 'ZZ_甲地';
  const SECOND = 'ZZ_乙地';
  const EDITED_AT = '2026-10-07T08:09:10.000Z';
  /** 业务读取语句的特征（loadEmploymentBusiness 里独有的试用期版本表）。 */
  const BUSINESS_READ = 'employment_probation_versions';

  /** 包一层 Db：含业务读取语句的事务提交之后，立即执行一次 after（只执行一次），再返回——此时事务已结束，PGlite 不死锁。 */
  function interleavedDb(db: Db, after: () => Promise<void>): { db: Db; fired: () => boolean } {
    let fired = false;
    const forward = (target: object, prop: string | symbol) => {
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const proxy = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'transaction') return forward(target, prop);
        return async (fn: (tx: Tx) => Promise<unknown>, config?: object) => {
          let readBusiness = false;
          const result = await (
            target.transaction as (f: (tx: Tx) => Promise<unknown>, c?: object) => Promise<unknown>
          )(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(inner, name) {
                    if (name !== 'execute') return forward(inner, name);
                    return (query: { queryChunks?: unknown }) => {
                      if (JSON.stringify(query.queryChunks ?? []).includes(BUSINESS_READ)) readBusiness = true;
                      return (inner.execute as (q: unknown) => Promise<unknown>).call(inner, query);
                    };
                  },
                }),
              ),
            config,
          );
          if (readBusiness && !fired) {
            fired = true;
            await after();
          }
          return result;
        };
      },
    });
    return { db: proxy, fired: () => fired };
  }

  it('GET 读完业务后、有一条真实 PATCH 改了工作地：返回成对的旧值 + 旧来源，下一次 GET 才是新值 + 新来源', async () => {
    const w = await approvalWorld(database().db, `emp30-snap-${uniqueSuffix()}`);
    w.setNow('2026-10-01T01:00:00Z');
    const dept = await w.org('快照部门');
    const created = await w.employee('快照员工');
    const hire = await w.hire(created.id, { departmentId: dept, place: FIRST });
    const patchPlace = async () => {
      w.setNow(EDITED_AT);
      const current = await w.business(hire.id);
      const patched = await w.request(w.hr.id, 'PATCH', `${BASE}/records/${hire.id}`, {
        ifMatch: current.revision,
        body: { fields: { place: SECOND } },
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
    };
    const hooked = interleavedDb(w.db, patchPlace);
    const api = tenantApi(hooked.db, { clock: w.clock });
    const placeOf = async () => {
      const response = await api.request('GET', `${BASE}/businesses/${hire.id}/field-origins`, w.as(w.hr.id));
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { fields: (OriginField & { origin: { at: string } | null })[] };
      return body.fields.find((f) => f.fieldCode === 'preset:place');
    };

    const racing = await placeOf();
    expect(hooked.fired(), '交错点已触发').toBe(true);
    expect(racing).toMatchObject({ value: FIRST });
    expect(racing?.origin?.at).not.toBe(EDITED_AT);

    const settled = await placeOf();
    expect(settled).toMatchObject({ value: SECOND, origin: { kind: 'hr-record', at: EDITED_AT } });
  });
});

describe('AC-EMP-30 只读来源接口：延迟继承字段落地后不再待解析', () => {
  it('关闭自动带出的直接调动：落地前 pending = true，调度顺延落地后 pending = false（策略仍是 deferred）', async () => {
    const w = await activationWorld(database().db, `emp30-pending-${uniqueSuffix()}`);
    const configured = await w.session.request('PUT', '/transfers/settings', {
      ifMatch: 0,
      body: { unrestrictTargetDepartment: false, autoPopulate: false },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const person = await w.hired();
    const transfer = await w.session.business(
      person.employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
      person.hire.employeeRevision,
    );
    const placeRow = async () => {
      const response = await w.session.request('GET', `/businesses/${transfer.id}/field-origins`);
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { fields: (OriginField & { policy: string; pending: boolean })[] };
      return body.fields.find((f) => f.fieldCode === 'preset:place');
    };

    expect(await placeRow()).toMatchObject({ value: '原地点', policy: 'deferred', pending: true });
    const run = await w.runScheduler('2026-10-06T01:00:00Z');
    expect(run).toMatchObject({ failed: [], errors: [] });
    expect(await w.session.record(transfer.id, '2026-10-06')).toMatchObject({ fields: { place: '原地点' } });
    expect(await placeRow()).toMatchObject({ value: '原地点', policy: 'deferred', pending: false });
  });
});
