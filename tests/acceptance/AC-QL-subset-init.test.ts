/**
 * AC-QL-subset-init（R3-T02 C1-5；设计 §4.1 初始化行、§4.2、§5.1 点名的批量命令；QL-R15①、DEC-251、DEC-067、DEC-414）：
 * 管理员按员工批（≤ 500）把历史任职记录一次性生成任职资格子集，只新增、不更新：
 * - 批量上限与请求结构：1～500、不重复、严格对象、Idempotency-Key 必带；
 * - 类别 / 级别 = 记录岗职务唯一映射（同 C1-4），不唯一 / 没有命中 → 该记录回执 skipped；日期 = 记录区间（统一时间轴）；
 * - 重复执行不重复生成（同键同内容返回首次回执；换键再跑 → ALREADY_EXISTS）；
 * - 逐名员工检查操作人人员范围：范围外与不存在同一回执 EMPLOYEE_NOT_FOUND，重放时按当前范围重新裁剪；
 * - 来源 initialization、带任职记录 ID，之后同一记录的逐条同步在同日让路（MANUAL_SAME_DAY）；
 * - 写入、版本、审计同事务，操作人是写入者。
 * 测试用合成数据。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf, syncWorld, type SyncWorld } from './AC-QL-sync-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const PATH = '/api/tenant/qualification/subsets/initialize';
const TODAY = '2026-10-10T05:00:00Z';
const CLOCK = () => new Date(TODAY);

interface RecordReceipt {
  recordId: string;
  outcome: 'created' | 'skipped';
  reason?: string;
  subsetId?: string;
}
type EmployeeReceipt =
  | { employeeId: string; outcome: 'skipped'; reason: string }
  | { employeeId: string; outcome: 'processed'; created: number; records: RecordReceipt[] };
interface Receipts {
  items: EmployeeReceipt[];
}

/** 一名员工 + 两个序列各映射到一个类别、一个职级映射到一个级别；夹具自带的入职事件视为已处理。 */
async function scene(label: string) {
  const w = await syncWorld(database().db, label);
  const jobLevelId = await w.jobLevel();
  const levelId = await w.level({ type: 'level', jobObjectId: jobLevelId });
  const sequences = [await w.sequence('序列一'), await w.sequence('序列二')];
  const categories = [
    await w.category({ type: 'sequence', jobObjectId: sequences[0]! }),
    await w.category({ type: 'sequence', jobObjectId: sequences[1]! }),
  ];
  await w.settleBaseline();
  const fields = (n: 0 | 1) => ({ sequenceId: sequences[n]!, levelId: jobLevelId });
  const api = tenantApi(w.db, { clock: CLOCK });
  const init = (employeeIds: string[], options: { key?: string | null } = {}) =>
    api.request('POST', PATH, {
      ...w.as,
      body: { employeeIds },
      ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
    });
  const initOk = async (employeeIds: string[]): Promise<Receipts> => {
    const response = await init(employeeIds);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Receipts;
  };
  const processed = (receipts: Receipts, employeeId = w.subject.employee.id) => {
    const receipt = receipts.items.find((item) => item.employeeId === employeeId)!;
    expect(receipt.outcome).toBe('processed');
    return receipt as Extract<EmployeeReceipt, { outcome: 'processed' }>;
  };
  return { w, jobLevelId, levelId, sequences, categories, fields, api, init, initOk, processed };
}

const errorOf = async (response: Response) =>
  ((await response.clone().json()) as { error: { code: string; details?: { reason?: string } } }).error;

describe('AC-QL-subset-init 请求结构与批量上限（设计 §4.1，DEC-067）', () => {
  it('员工数 0 / 501、重复员工、多余字段、非 UUID 均 400，不写任何行；501 之内（含恰好 500）合法（AC-QL-subset-init）', async () => {
    const { w, api, init } = await scene('qlinit-input');
    const one = w.subject.employee.id;
    const many = (n: number) => Array.from({ length: n }, () => randomUUID());
    for (const employeeIds of [[], many(501), [one, one], ['not-a-uuid']]) {
      const response = await init(employeeIds);
      expect(response.status, JSON.stringify(employeeIds).slice(0, 60)).toBe(400);
      expect((await errorOf(response)).code).toBe('VALIDATION_FAILED');
    }
    const extra = await api.request('POST', PATH, { ...w.as, body: { employeeIds: [one], all: true } });
    expect(extra.status).toBe(400);
    const exactly = await init(many(500));
    expect(exactly.status, await exactly.clone().text()).toBe(200);
    expect(((await exactly.json()) as Receipts).items).toHaveLength(500);
    expect(await w.subsets()).toEqual([]);
  });

  it('必带 Idempotency-Key：缺失 400 IDEMPOTENCY_KEY_REQUIRED（AC-QL-subset-init）', async () => {
    const { w, init } = await scene('qlinit-key');
    const response = await init([w.subject.employee.id], { key: null });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('AC-QL-subset-init 映射与日期（QL-R15①，设计 §4.2）', () => {
  it('每条已生效记录生成一行：类别 / 级别 = 唯一映射，开始日 = 记录生效日，结束日 = 下一条前一天，最后一条开放（AC-QL-subset-init）', async () => {
    const { w, categories, levelId, fields, initOk, processed } = await scene('qlinit-dates');
    const first = await w.transferWith('2026-09-10', fields(0));
    const second = await w.transferWith('2026-10-05', fields(1));
    const receipts = await initOk([w.subject.employee.id]);
    const receipt = processed(receipts);
    // 夹具的入职记录没有岗职务映射：该记录回执 NO_MAPPING，其他两条各生成一行
    expect(receipt.created).toBe(2);
    expect(receipt.records.map((record) => [record.recordId, record.outcome, record.reason])).toEqual([
      [w.subject.hire.id, 'skipped', 'NO_MAPPING'],
      [first, 'created', undefined],
      [second, 'created', undefined],
    ]);
    expect(receipt.records.every((record) => Object.keys(record).every((key) => !key.includes('Date')))).toBe(true);
    expect(await w.subsets()).toMatchObject([
      {
        categoryId: categories[0],
        levelId,
        startDate: '2026-09-10',
        endDate: '2026-10-04',
        sourceType: 'initialization',
        sourceId: first,
        isAutoSync: false,
        employmentRecordId: first,
      },
      {
        categoryId: categories[1],
        levelId,
        startDate: '2026-10-05',
        endDate: null,
        sourceType: 'initialization',
        sourceId: second,
        isAutoSync: false,
        employmentRecordId: second,
      },
    ]);
  });

  it('只生成已生效的入职 / 转正 / 调动类记录：未来生效的、离职的不生成（AC-QL-subset-init）', async () => {
    const { w, fields, initOk, processed } = await scene('qlinit-kinds');
    const transfer = await w.transferWith('2026-09-10', fields(0));
    await w.transferWith('2099-01-01', fields(1));
    await w.leave('2026-10-02');
    const receipt = processed(await initOk([w.subject.employee.id]));
    expect(receipt.records.map((record) => record.recordId)).toEqual([w.subject.hire.id, transfer]);
    expect(await w.subsets()).toMatchObject([{ startDate: '2026-09-10', endDate: null }]);
  });

  it('同一生效日多笔只取最后一笔（DEC-108）（AC-QL-subset-init）', async () => {
    const { w, categories, fields, initOk, processed } = await scene('qlinit-same-day');
    await w.transferWith('2026-09-10', fields(0));
    const last = await w.transferWith('2026-09-10', fields(1));
    const receipt = processed(await initOk([w.subject.employee.id]));
    // 同日先存的那笔不出现在回执里，只有当日最后一笔参与生成
    expect(receipt.records.map((record) => record.recordId)).toEqual([w.subject.hire.id, last]);
    expect(receipt.records[1]).toMatchObject({ outcome: 'created' });
    expect(await w.subsets()).toMatchObject([{ categoryId: categories[1], employmentRecordId: last }]);
  });

  it('岗职务映射不唯一 / 没有命中 → 该记录 skipped（AMBIGUOUS_MAPPING / NO_MAPPING），不生成，不影响其他记录（AC-QL-subset-init）', async () => {
    const { w, fields, initOk, processed } = await scene('qlinit-ambiguous');
    // 职级与职等各关联一个不同的启用级别：并集有两个，级别不唯一
    const ambiguousJobLevel = await w.jobLevel();
    const ambiguousJobGrade = await w.jobGrade();
    await w.level({ type: 'level', jobObjectId: ambiguousJobLevel });
    await w.level({ type: 'grade', jobObjectId: ambiguousJobGrade });
    const sequenceId = await w.sequence('歧义序列');
    await w.category({ type: 'sequence', jobObjectId: sequenceId });
    const ok = await w.transferWith('2026-09-10', fields(0));
    const ambiguous = await w.transferWith('2026-09-20', {
      sequenceId,
      levelId: ambiguousJobLevel,
      gradeId: ambiguousJobGrade,
    });
    const receipt = processed(await initOk([w.subject.employee.id]));
    const byRecord = new Map(receipt.records.map((record) => [record.recordId, record]));
    expect(byRecord.get(ok)).toMatchObject({ outcome: 'created' });
    expect(byRecord.get(ambiguous)).toMatchObject({ outcome: 'skipped', reason: 'AMBIGUOUS_MAPPING' });
    expect(await w.subsets()).toHaveLength(1);
  });
});

describe('AC-QL-subset-init 重复执行不重复生成（QL-R15①：只新增、不更新）', () => {
  it('同键同内容返回首次回执；换键再跑 → 全部 ALREADY_EXISTS，行数与版本不变（AC-QL-subset-init）', async () => {
    const { w, fields, init, initOk, processed } = await scene('qlinit-repeat');
    await w.transferWith('2026-09-10', fields(0));
    const key = randomUUID();
    const first = await init([w.subject.employee.id], { key });
    const body = await first.json();
    const replay = await init([w.subject.employee.id], { key });
    expect(await replay.json()).toEqual(body);
    expect(await w.subsets()).toHaveLength(1);

    const again = processed(await initOk([w.subject.employee.id]));
    expect(again.created).toBe(0);
    expect(again.records.filter((record) => record.outcome === 'skipped').map((record) => record.reason)).toEqual([
      'NO_MAPPING',
      'ALREADY_EXISTS',
    ]);
    expect(await w.subsets()).toHaveLength(1);
    expect(await w.history()).toHaveLength(1);
  });

  it('同键异内容 → 409 IDEMPOTENCY_CONFLICT（AC-QL-subset-init）', async () => {
    const { w, init } = await scene('qlinit-conflict');
    const key = randomUUID();
    expect((await init([w.subject.employee.id], { key })).status).toBe(200);
    const different = await init([w.subject.employee.id, randomUUID()], { key });
    expect(different.status).toBe(409);
    expect((await errorOf(different)).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('已被 HR 删除的行不算“已有”：再次初始化会重新生成（显式管理员命令，不同于逐条同步的 DEC-407 不补回）（AC-QL-subset-init）', async () => {
    const { w, fields, initOk } = await scene('qlinit-after-delete');
    await w.transferWith('2026-09-10', fields(0));
    await initOk([w.subject.employee.id]);
    const [row] = await w.subsets();
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE personnel_qualification SET deleted = true WHERE id = ${row!.id}::uuid`),
    );
    expect(await w.subsets()).toEqual([]);
    await initOk([w.subject.employee.id]);
    expect(await w.subsets()).toHaveLength(1);
  });
});

describe('AC-QL-subset-init 与逐条同步的衔接（DEC-414：手工优先）', () => {
  it('初始化之后同一记录的逐条同步在同日让路：MANUAL_SAME_DAY，不重复生成（AC-QL-subset-init）', async () => {
    const { w, fields, initOk } = await scene('qlinit-then-sync');
    const record = await w.transferWith('2026-09-10', fields(0));
    await initOk([w.subject.employee.id]);
    await w.enableSync(true);
    await w.run(TODAY);
    expect(await w.queue(record)).toMatchObject([{ state: 'skipped', reason: 'MANUAL_SAME_DAY' }]);
    expect(await w.subsets()).toHaveLength(1);
  });
});

describe('AC-QL-subset-init 写入主体与审计（DEC-019）', () => {
  it('每个生成的行：版本一条、审计一条，写入者 = 操作人，来源 initialization；事务内同提交（AC-QL-subset-init）', async () => {
    const { w, fields, initOk } = await scene('qlinit-audit');
    await w.transferWith('2026-09-10', fields(0));
    await w.transferWith('2026-10-05', fields(1));
    await initOk([w.subject.employee.id]);
    const versions = await w.history();
    expect(versions).toMatchObject([
      { revision: 1, sourceType: 'initialization' },
      { revision: 1, sourceType: 'initialization' },
    ]);
    const audits = await withTenant(w.db, w.tenantId, async (tx) =>
      rowsOf<{ actor: string }>(
        await tx.execute(sql`SELECT actor_user_id AS actor FROM audit_events
          WHERE tenant_id=${w.tenantId} AND object_type='TenantBase.Qualification'`),
      ),
    );
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(audit.actor).toBe(w.session.user.id);
  });
});

/** 受控范围与功能权限的操作人：scope 给出人员范围（组织维度），deny 拒绝某些授权请求。 */
function restricted(
  world: SyncWorld,
  options: { orgIds: string[]; deny?: (request: Parameters<Authorizer>[0]) => boolean },
) {
  const authorize: Authorizer = (request) => !options.deny?.(request);
  const scope: ModuleScope = {
    ...EMPTY_SCOPE,
    orgIds: options.orgIds,
    hasDataPermission: true,
    terms: [
      {
        dimension: 'organization',
        orgIds: options.orgIds,
        personIds: [],
        personQuery: { kind: 'organization', tenantId: world.tenantId, asOf: '2026-10-10' },
      },
    ],
  };
  registerScopeProvider(authorize, {
    scope: async () => scope,
    authorize: async (request) => authorize(request),
    fields: async () => undefined as never,
  });
  const api = tenantApi(world.db, { authorize, clock: CLOCK });
  return {
    request: (employeeIds: string[], key = randomUUID()) =>
      api.request('POST', PATH, { ...world.as, body: { employeeIds }, idempotencyKey: key }),
  };
}

describe('AC-QL-subset-init 逐名员工检查操作人人员范围（设计 §5.1，DEC-317②）', () => {
  /** 范围内：subject（部门 to）；范围外：另一名员工（部门 from）；不存在：随机 UUID。 */
  async function outsideScene(label: string) {
    const s = await scene(label);
    const { w, fields } = s;
    const outsider = await w.session.employee('范围外员工');
    await w.session.business(
      outsider.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: w.from.id } },
      outsider.revision,
    );
    await w.transferWith('2026-09-10', { ...fields(0), departmentId: w.from.id }, outsider.id);
    await w.transferWith('2026-09-10', fields(0));
    return { ...s, outsiderId: outsider.id };
  }

  it('范围外与不存在同一回执 EMPLOYEE_NOT_FOUND（除员工 ID 外逐字相同），范围外员工不生成任何行（AC-QL-subset-init）', async () => {
    const s = await outsideScene('qlinit-scope');
    const { w, outsiderId } = s;
    const operator = restricted(w, { orgIds: [w.to.id] });
    const missing = randomUUID();
    const response = await operator.request([w.subject.employee.id, outsiderId, missing]);
    expect(response.status, await response.clone().text()).toBe(200);
    const { items } = (await response.json()) as Receipts;
    expect(items.map((item) => item.employeeId)).toEqual([w.subject.employee.id, outsiderId, missing]);
    expect(items[0]).toMatchObject({ outcome: 'processed', created: 1 });
    const { employeeId: _a, ...outsideShape } = items[1]!;
    const { employeeId: _b, ...missingShape } = items[2]!;
    expect(outsideShape).toEqual({ outcome: 'skipped', reason: 'EMPLOYEE_NOT_FOUND' });
    expect(outsideShape).toEqual(missingShape);
    expect(await w.subsets(outsiderId)).toEqual([]);
    expect(await w.subsets()).toHaveLength(1);
  });

  it('范围为空（缺省）时全部员工同一回执，不生成任何行（硬规则：数据范围缺省为空）（AC-QL-subset-init）', async () => {
    const { w } = await outsideScene('qlinit-empty-scope');
    const operator = restricted(w, { orgIds: [] });
    const response = await operator.request([w.subject.employee.id]);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Receipts).items).toEqual([
      { employeeId: w.subject.employee.id, outcome: 'skipped', reason: 'EMPLOYEE_NOT_FOUND' },
    ]);
    expect(await w.subsets()).toEqual([]);
  });

  it('没有 TenantBase.Qualification 新增权限 → 403，不写任何行（AC-QL-subset-init）', async () => {
    const { w } = await outsideScene('qlinit-forbidden');
    const operator = restricted(w, {
      orgIds: [w.to.id],
      deny: (request) => request.action === 'object.create' && request.resource === 'TenantBase.Qualification',
    });
    const response = await operator.request([w.subject.employee.id]);
    expect(response.status).toBe(403);
    expect(await w.subsets()).toEqual([]);
  });

  it('列表层“新增”按钮被撤销 → 403（与 HR 逐个新增同一道门）（AC-QL-subset-init）', async () => {
    const { w } = await outsideScene('qlinit-button');
    const operator = restricted(w, {
      orgIds: [w.to.id],
      deny: (request) =>
        request.action === 'object.button' && String(request.resource).includes('TenantBase.Qualification'),
    });
    expect((await operator.request([w.subject.employee.id])).status).toBe(403);
    expect(await w.subsets()).toEqual([]);
  });

  it('幂等重放按当前范围重新裁剪：撤权后同键重放，原范围内员工显示为 EMPLOYEE_NOT_FOUND，不再带出明细（AC-QL-subset-init）', async () => {
    const { w } = await outsideScene('qlinit-replay');
    const key = randomUUID();
    const before = restricted(w, { orgIds: [w.to.id] });
    const first = await before.request([w.subject.employee.id], key);
    expect(((await first.json()) as Receipts).items[0]).toMatchObject({ outcome: 'processed' });
    const after = restricted(w, { orgIds: [] });
    const replay = await after.request([w.subject.employee.id], key);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Receipts).items).toEqual([
      { employeeId: w.subject.employee.id, outcome: 'skipped', reason: 'EMPLOYEE_NOT_FOUND' },
    ]);
  });
});
