/**
 * 同步端口共用契约测试（《R3-T04/T05 同步协议》SP-18）：runSyncPortContractSuite(name, factory) 对替身与真实实现跑
 * 同一套用例，覆盖 SP-02～SP-17 的规则、SP-14 回执组合表（R1～R14、R4a、R4b 的正反例）与 SP-19 中 T04 契约套件承担的
 * 交错（5、6、9、12、13、14、15①②③、16、17 的契约部分；10、11 健康度）。T05 只加用例，不另定类型。
 * 夹具（syncFixture）是协议层面的场景描述：真实实现的工厂按它落库（冻结表、来源项目、健康度行），并提供同一组控制
 * （撤权、取代、拨时钟）。本文件不是测试文件，不会自行注册用例：替身由 AC-TR-sync-contract.test.ts 跑，
 * T05 / PR-D 引用本文件跑各自的工厂，不会重复跑替身。
 *
 * 事务约定（SP-11）：harness.transaction 是一个真实事务边界——失败只回滚本事务的写入，不覆盖其他已提交事务；
 * 消费记录按 S / X 锁等待（执行页 assertExecutionActive 取 S，接管 / 终止 / 完成 / 取代取 X）。
 */
import type { Tx } from '@italent/db';
import { SYNC_ERROR_CODES, type OutcomeItem, type SyncNomination, type SyncTargetRegistration } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import type {
  InMemorySyncData,
  InMemorySyncPort,
} from '../../../apps/api/src/modules/talent-review/sync-port-memory.js';
import type { TalentReviewSyncPort } from '../../../apps/api/src/modules/talent-review/sync-port.js';

/** 契约所需的控制面：替身直接实现；真实实现的夹具按同名语义改库或改授权。 */
export interface SyncPortHarness {
  readonly port: TalentReviewSyncPort;
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  supersede(runId: string): Promise<void>;
  revoke(change: Parameters<InMemorySyncPort['revoke']>[0]): Promise<void>;
  denyViewer(userId: string, denied: Parameters<InMemorySyncPort['denyViewer']>[1]): Promise<void>;
  denyHealthWrite(userId: string, access: Parameters<InMemorySyncPort['denyHealthWrite']>[1]): Promise<void>;
  endProject(projectId: string): Promise<void>;
  advance(seconds: number): Promise<void>;
}
export type SyncPortFactory = (fixture: InMemorySyncData) => Promise<SyncPortHarness>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const FX = {
  tenant: id(1),
  run: id(2),
  project: id(3),
  owner: id(4),
  actor: id(5),
  principal: id(6),
  writer: id(7),
  viewer: id(8),
  foreign: id(9),
  o1: id(11),
  o2: id(12),
  o3: id(13),
  e1: id(21),
  e2: id(22),
  e3: id(23),
  e4: id(24),
  n1: id(31),
  n2: id(32),
  n3: id(33),
  g1: id(41),
  g2: id(42),
  p1: id(51),
  meeting: id(61),
  oldProject: id(62),
  olderProject: id(63),
  matrix: id(71),
  readyNow: id(81),
  readyLater: id(82),
} as const;
const T_G1 = `org:${FX.g1}` as const;
const T_P1 = `position:${FX.p1}` as const;
const FROZEN = new Date('2026-10-09T01:00:00Z');

const nomination = (nominationId: string, extra: Partial<SyncNomination>): SyncNomination => ({
  nominationId,
  objectId: FX.o1,
  employeeId: FX.e1,
  kind: 'org',
  direction: 'successor',
  orgId: FX.g1,
  positionId: null,
  successorEmployeeId: FX.e3,
  readinessId: FX.readyNow,
  readinessCode: 'RN1',
  sortNo: 1,
  createdAt: FROZEN,
  syncEligible: true,
  formValues: { remark: { status: 'value', value: '可培养' } },
  ...extra,
});
const N1 = nomination(FX.n1, {});
const N2 = nomination(FX.n2, { kind: 'position', orgId: null, positionId: FX.p1, sortNo: 2 });
const N3 = nomination(FX.n3, {
  objectId: FX.o2,
  employeeId: FX.e2,
  direction: 'target',
  successorEmployeeId: FX.e2,
  syncEligible: false,
});

const runObject = (objectId: string, employeeId: string, inFlow: boolean) => ({
  objectId,
  employeeId,
  status: inFlow ? ('in_flow' as const) : ('flow_ended' as const),
  syncEligible: !inFlow,
  blockReason: inFlow ? ('in_flow' as const) : null,
  fields: { potential: { status: 'value' as const, value: 'high' } },
  matrices: [],
  calibrated: false,
  resultSeq: 1,
  resultAt: FROZEN,
  successionModule: 'present' as const,
});

type Source = NonNullable<InMemorySyncData['sources']>[number];
const source = (projectId: string, extra: Partial<Source>): Source => ({
  projectId,
  meetingId: null,
  code: projectId,
  status: 'in_progress',
  periodStartDate: '2026-09-01',
  periodEndDate: '2026-12-31',
  businessDate: null,
  objects: [],
  ...extra,
});

/**
 * 一个 run：O1（流程结束，两条 successor 提名：组织 G1、职位 P1），O2（流程中，只有一条 target 提名），
 * 健康度 G1 有值、G2 未提供。来源：进行中的当前项目（9 月起）、6 月与 3 月结束的两个历史项目、一个校准会。
 * withEmptyObject = true 时另加一个没有提名的对象 O3（SP-12 no_nominations）。
 */
export function syncFixture(options: { withEmptyObject?: boolean } = {}): InMemorySyncData {
  const health = (orgId: string, status: 'value' | 'not_provided') => ({
    orgId,
    meetingId: null,
    levelId: status === 'value' ? FX.readyNow : null,
    levelCode: status === 'value' ? 'H1' : null,
    manual: false,
    status,
    succession: { status: 'present' as const, count: 0, nominations: [] },
  });
  const objects = [runObject(FX.o1, FX.e1, false), runObject(FX.o2, FX.e2, true)];
  if (options.withEmptyObject) objects.push(runObject(FX.o3, FX.e4, false));
  return {
    tenantId: FX.tenant,
    now: FROZEN,
    runs: [
      {
        header: {
          runId: FX.run,
          projectId: FX.project,
          projectName: '2026 年度盘点',
          ownerOrgId: FX.g1,
          trigger: 'sync_requested',
          businessDate: '2026-10-09',
          principalUserId: FX.principal,
          actorUserId: FX.actor,
          ownerUserId: FX.owner,
          manualOverride: false,
          scopeOrgIds: [],
          scopeExplicit: false,
          frozenAt: FROZEN,
          status: 'frozen',
          supersededByRunId: null,
          objectCount: objects.length,
          nominationCount: 3,
          orgHealthCount: 2,
          excludedCount: 0,
        },
        objects,
        nominations: [N1, N2, N3],
        orgHealth: [health(FX.g1, 'value'), health(FX.g2, 'not_provided')],
      },
    ],
    fields: [
      { code: 'potential', label: '潜力', group: '结果', kind: 'option', systemWritten: false, formulaUsable: true },
      { code: 'tags', label: '标签', group: '结果', kind: 'multi_option', systemWritten: false, formulaUsable: true },
    ],
    sources: [
      source(FX.olderProject, {
        status: 'ended',
        periodStartDate: '2026-01-01',
        periodEndDate: '2026-03-31',
        objects: [
          { employeeId: FX.e1, orgId: FX.g1, fields: { potential: { status: 'value', value: 'low' } }, succession: [] },
        ],
      }),
      source(FX.oldProject, {
        status: 'ended',
        periodStartDate: '2026-04-01',
        periodEndDate: '2026-06-30',
        objects: [
          {
            employeeId: FX.e1,
            orgId: FX.g1,
            fields: { potential: { status: 'value', value: 'mid' } },
            succession: null,
          },
        ],
      }),
      source(FX.project, {
        businessDate: '2026-09-15',
        objects: [
          {
            employeeId: FX.e1,
            orgId: FX.g1,
            fields: { potential: { status: 'value', value: 'high' } },
            succession: [N1, N2],
            placement: { matrixId: FX.matrix, placement: 9, countsGreen: true },
          },
          {
            employeeId: FX.e2,
            orgId: FX.g1,
            fields: {},
            succession: [],
            placement: { matrixId: FX.matrix, placement: 1, countsGreen: false },
          },
        ],
      }),
      source(FX.project, {
        meetingId: FX.meeting,
        objects: [
          { employeeId: FX.e2, orgId: FX.g1, fields: { potential: { status: 'value', value: 'low' } }, succession: [] },
        ],
      }),
    ],
    healthRows: [
      {
        context: { projectId: FX.project, meetingId: null },
        orgId: FX.g1,
        levelId: FX.readyNow,
        levelCode: 'H1',
        status: 'value',
        manual: true,
        method: 'manual',
        revision: 3,
      },
    ],
    readiness: [
      {
        id: FX.readyLater,
        code: 'RN3',
        name: '1~2 年',
        description: null,
        color: '#999999',
        sortNo: 2,
        enabled: false,
      },
      { id: FX.readyNow, code: 'RN1', name: '1 年内', description: null, color: '#00AA00', sortNo: 1, enabled: true },
    ],
  };
}

const key = { tenantId: FX.tenant, runId: FX.run, consumer: 'succession' as const };
const item = (rowKind: OutcomeItem['rowKind'], rowId: string, extra: Partial<OutcomeItem> = {}): OutcomeItem => ({
  rowKind,
  rowId,
  status: 'synced',
  recovery: 'none',
  executionNo: null,
  pageCommandId: null,
  updatedAt: FROZEN,
  ...extra,
});
const failed = (rowKind: OutcomeItem['rowKind'], rowId: string, errorCode: OutcomeItem['errorCode'], extra = {}) =>
  item(rowKind, rowId, { status: 'failed', errorCode, ...extra });
const skipped = (rowKind: OutcomeItem['rowKind'], rowId: string, reason: string) =>
  item(rowKind, rowId, { status: 'skipped', errorParams: { reason } });
const TARGETS: readonly SyncTargetRegistration[] = [
  { targetKey: T_G1, action: 'overwrite', nominationIds: [FX.n1] },
  { targetKey: T_P1, action: 'append', nominationIds: [FX.n2] },
];
/** 计划阶段已确定终态的行：target 方向提名与只有 target 提名的对象 O2 跳过（SP-12 全部 skipped）、G2 未提供跳过。 */
const PLAN_SKIPS = [
  skipped('nomination', FX.n3, 'direction_target'),
  skipped('object', FX.o2, 'direction_target'),
  skipped('org_health', FX.g2, 'not_provided'),
];
const page = (no: number, executionNo = 1) => `${FX.run}:succession:${executionNo}:${no}`;
const code = (error: unknown) => (error as { code?: string } | undefined)?.code;

/** 可控交错：gate.open() 之前事务停在 gate.wait；settledWithin 判断另一个事务是否在等锁。 */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}
const settledWithin = (promise: Promise<unknown>, ms = 80) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

export function runSyncPortContractSuite(name: string, factory: SyncPortFactory): void {
  const setup = async (fixture = syncFixture()) => {
    const h = await factory(fixture);
    const tx = <T>(work: (port: TalentReviewSyncPort, tx: Tx) => Promise<T>) => h.transaction((t) => work(h.port, t));
    const begin = (leaseOwner = 'w1', leaseSeconds = 60) =>
      tx((p, t) => p.beginConsumption(t, { ...key, leaseOwner, leaseSeconds }));
    const active = (t: Tx, p: TalentReviewSyncPort, executionNo = 1, leaseOwner = 'w1', requireSealed = true) =>
      p.assertExecutionActive(t, { ...key, executionNo, leaseOwner, requireSealed });
    /** 计划事务（SP-09 / SP-10）：beginConsumption 与 registerTargets 同一事务。 */
    const plan = (planOutcomes: OutcomeItem[] = [], options: { leaseSeconds?: number; owner?: string } = {}) =>
      tx(async (p, t) => {
        const state = await p.beginConsumption(t, {
          ...key,
          leaseOwner: options.owner ?? 'w1',
          leaseSeconds: options.leaseSeconds ?? 60,
        });
        await active(t, p, state.executionNo, options.owner ?? 'w1', false);
        return p.registerTargets(t, {
          ...key,
          executionNo: state.executionNo,
          planCommandId: 'plan-1',
          targets: TARGETS,
          planOutcomes,
        });
      });
    /** 已有消费记录时单独重放计划提交（同一执行内）。 */
    const register = (planOutcomes: OutcomeItem[], planCommandId: string, targets = TARGETS) =>
      tx(async (p, t) => {
        await active(t, p, 1, 'w1', false);
        return p.registerTargets(t, { ...key, executionNo: 1, planCommandId, targets, planOutcomes });
      });
    /** 执行页（SP-11）：第一步 assertExecutionActive，再写回执。 */
    const record = (items: OutcomeItem[], pageNo = 1, executionNo = 1, owner = 'w1') =>
      tx(async (p, t) => {
        await active(t, p, executionNo, owner);
        return p.recordOutcome(t, { ...key, executionNo, pageNo, pageCommandId: page(pageNo, executionNo), items });
      });
    /** 独立终结事务（SP-11 第 3 个边界）。 */
    const complete = (executionNo = 1) => tx((p, t) => p.completeConsumption(t, { ...key, executionNo }));
    const outcomes = () => tx((p, t) => p.getOutcomes(t, { ...key, limit: 2000 }));
    const rowOf = async (rowId: string) => (await outcomes()).items.find((row) => row.rowId === rowId);
    const rejects = async (promise: Promise<unknown>, expected: string) => {
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(code(error), `应拒绝为 ${expected}`).toBe(expected);
    };
    return { h, tx, begin, active, plan, register, record, complete, outcomes, rowOf, rejects };
  };

  describe(`${name}：同步端口契约（SP-18；DEC-330 / 336 / 311）`, () => {
    describe('SP-02 / SP-05 / SP-06 冻结快照读取', () => {
      it('run 头只在本租户可见；对象按 objectId 分页，超过每页上限拒绝', async () => {
        const { tx } = await setup();
        expect(await tx((p, t) => p.loadRun(t, key))).toMatchObject({ runId: FX.run, trigger: 'sync_requested' });
        expect(await tx((p, t) => p.loadRun(t, { ...key, tenantId: FX.foreign }))).toBeNull();
        const first = await tx((p, t) => p.listRunObjects(t, { ...key, limit: 1 }));
        expect(first.items.map((o) => o.objectId)).toEqual([FX.o1]);
        const second = await tx((p, t) => p.listRunObjects(t, { ...key, limit: 1, after: first.next! }));
        expect([second.items.map((o) => o.objectId), second.next]).toEqual([[FX.o2], null]);
        await expect(tx((p, t) => p.listRunObjects(t, { ...key, limit: 501 }))).rejects.toThrow();
        const nominations = await tx((p, t) => p.listRunNominations(t, { ...key, limit: 2000 }));
        expect(nominations.items.map((n) => [n.nominationId, n.direction])).toEqual([
          [FX.n1, 'successor'],
          [FX.n2, 'successor'],
          [FX.n3, 'target'],
        ]);
        const health = await tx((p, t) => p.listRunOrgHealth(t, key));
        expect(health.map((row) => [row.orgId, row.status])).toEqual([
          [FX.g1, 'value'],
          [FX.g2, 'not_provided'],
        ]);
      });

      it('冻结时为消费方预建三类 pending 回执；目标行要到计划提交才出现', async () => {
        const { begin, outcomes } = await setup();
        const state = await begin();
        expect(state).toMatchObject({ status: 'running', executionNo: 1, targetsSealed: false, targetCount: 0 });
        expect(state.counts).toMatchObject({ pending: 7, synced: 0 });
        const rows = (await outcomes()).items;
        expect(rows.map((row) => row.rowKind).sort()).toEqual([
          'nomination',
          'nomination',
          'nomination',
          'object',
          'object',
          'org_health',
          'org_health',
        ]);
      });

      it('SP-14 码表收齐（契约逐码断言的基础）', () => {
        for (const expected of [
          'OUTCOME_NOT_ALLOWED',
          'NOMINATIONS_FAILED',
          'IDEMPOTENCY_CONFLICT',
          'RUN_SUPERSEDED',
        ]) {
          expect(SYNC_ERROR_CODES).toContain(expected);
        }
        expect(SYNC_ERROR_CODES).not.toContain('LEASE_LOST');
        expect(SYNC_ERROR_CODES).not.toContain('SOURCE_FORBIDDEN');
      });
    });

    describe('租户隔离：所有首次 / 失败 / 重放分支之前先校验租户', () => {
      it('外租户参数不能读写本租户的消费记录（完成后的重放分支同样拒绝）', async () => {
        const { tx, plan, record, complete, rejects } = await setup();
        await plan(PLAN_SKIPS);
        await record([
          item('target', T_G1),
          item('nomination', FX.n1),
          item('target', T_P1),
          item('nomination', FX.n2),
        ]);
        await record([item('object', FX.o1), item('org_health', FX.g1)], 2);
        await complete();
        const foreign = { ...key, tenantId: FX.foreign };
        await rejects(
          tx((p, t) => p.completeConsumption(t, { ...foreign, executionNo: 1 })),
          'EXECUTION_INACTIVE',
        );
        await rejects(
          tx((p, t) => p.getOutcomes(t, { ...foreign, limit: 10 })),
          'EXECUTION_INACTIVE',
        );
        await rejects(
          tx((p, t) => p.getPageCommit(t, { ...foreign, pageCommandId: page(1) })),
          'EXECUTION_INACTIVE',
        );
      });

      it('健康度回写与重置：外租户参数一律 FORBIDDEN，不带存在性与值，本租户健康度不变', async () => {
        const { tx } = await setup();
        const context = { projectId: FX.project, meetingId: null };
        const rows = [
          { orgId: FX.g1, levelId: FX.readyLater, levelCode: 'H2', status: 'value' as const, expectedRevision: 3 },
        ];
        const assign = await tx((p, t) =>
          p.recordOrgHealth(t, {
            tenantId: FX.foreign,
            context,
            credential: { kind: 'assign', userId: FX.writer, commandId: 'f1' },
            rows,
          }),
        );
        const reset = await tx((p, t) =>
          p.resetOrgHealth(t, {
            tenantId: FX.foreign,
            context,
            credential: { kind: 'reset', userId: FX.writer, commandId: 'f2' },
            rows,
          }),
        );
        for (const receipt of [assign, reset]) {
          expect(receipt.items).toEqual([
            { orgId: FX.g1, outcome: 'FORBIDDEN', currentRevision: 0, currentLevelId: null, currentManual: false },
          ]);
        }
        const [state] = await tx((p, t) =>
          p.readOrgHealthRows(t, {
            tenantId: FX.tenant,
            context,
            orgIds: [FX.g1],
            viewer: { kind: 'principal', userId: FX.principal },
          }),
        );
        expect(state).toMatchObject({ status: 'value', revision: 3, manual: true, levelId: FX.readyNow });
      });
    });

    describe('SP-07 源读取授权', () => {
      it('逐项撤权给出本页明细；整 run 不可读给出原因；取代后 runStatus = superseded', async () => {
        const { h, tx } = await setup();
        const authorize = (pageInput: object) => tx((p, t) => p.authorizeSourceRead(t, { ...key, page: pageInput }));
        expect(await authorize({ objectIds: [FX.o1] })).toMatchObject({ ok: true, runStatus: 'frozen' });
        await h.revoke({ objectIds: [FX.o1], fieldCodes: ['potential'], orgIds: [FX.g2] });
        const partial = await authorize({ nominationIds: [FX.n1], fieldCodes: ['potential'], orgIds: [FX.g1, FX.g2] });
        expect(partial.ok).toBe(true);
        expect(partial.forbidden).toMatchObject({
          objectIds: [FX.o1],
          fields: { [FX.o1]: ['potential'] },
          orgIds: [FX.g2],
        });
        await h.revoke({ principal: true });
        expect(await authorize({})).toMatchObject({ ok: false, reason: 'PRINCIPAL_UNAVAILABLE' });
        await h.supersede(FX.run);
        expect(await authorize({})).toMatchObject({ ok: false, runStatus: 'superseded' });
      });

      it('健康度页只给组织与字段：字段撤权逐组织给出（SP-14 R7 可执行）', async () => {
        const { h, tx } = await setup();
        await h.revoke({ fieldCodes: ['levelId'] });
        const result = await tx((p, t) =>
          p.authorizeSourceRead(t, { ...key, page: { orgIds: [FX.g1, FX.g2], fieldCodes: ['levelId'] } }),
        );
        expect(result.ok).toBe(true);
        expect(result.forbidden.orgFields).toEqual({ [FX.g1]: ['levelId'], [FX.g2]: ['levelId'] });
        expect(result.forbidden.fields).toEqual({});
      });
    });

    describe('SP-08 消费租约与执行序号', () => {
      it('租约有效时另一执行被拒；过期后接管，旧执行一律 EXECUTION_INACTIVE', async () => {
        const { h, tx, begin, rejects } = await setup();
        await begin('w1', 30);
        await rejects(begin('w2'), 'CONSUMPTION_LEASED');
        await h.advance(31);
        expect(await begin('w2')).toMatchObject({ executionNo: 2, leaseOwner: 'w2' });
        const old = { ...key, executionNo: 1, leaseOwner: 'w1', leaseSeconds: 30 };
        await rejects(
          tx((p, t) => p.renewLease(t, old)),
          'EXECUTION_INACTIVE',
        );
        await rejects(
          tx((p, t) => p.assertExecutionActive(t, { ...old, requireSealed: false })),
          'EXECUTION_INACTIVE',
        );
        await rejects(
          tx((p, t) => p.renewLease(t, { ...old, executionNo: 2 })),
          'EXECUTION_INACTIVE',
        );
        await tx((p, t) =>
          p.assertExecutionActive(t, { ...key, executionNo: 2, leaseOwner: 'w2', requireSealed: false }),
        );
      });
    });

    describe('SP-10 计划提交（SP-19 #6、#12）', () => {
      it('全部成功的计划：一次登记封存目标并写 plan 提交证明；行仍 pending，完成被拒', async () => {
        const { tx, plan, outcomes, complete, rejects } = await setup();
        const { state, pageCommit } = await plan();
        expect(pageCommit).toEqual({
          runId: FX.run,
          consumer: 'succession',
          executionNo: 1,
          pageNo: 0,
          pageCommandId: page(0),
          kind: 'plan',
          rowCount: 0,
          committedAt: expect.any(Date),
        });
        expect(state).toMatchObject({ targetsSealed: true, targetCount: 2 });
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(0) }))).toMatchObject({
          kind: 'plan',
        });
        const targets = (await outcomes()).items.filter((row) => row.rowKind === 'target');
        expect(targets.map((row) => [row.rowId, row.status])).toEqual([
          [T_G1, 'pending'],
          [T_P1, 'pending'],
        ]);
        await rejects(complete(), 'PENDING_ROWS_REMAIN');
      });

      it('计划事务失败整体回滚：没有消费记录、没有封存，重新计划从执行序号 1 开始', async () => {
        const { tx, begin } = await setup();
        await tx(async (p, t) => {
          await p.beginConsumption(t, { ...key, leaseOwner: 'w1', leaseSeconds: 60 });
          await p.registerTargets(t, {
            ...key,
            executionNo: 1,
            planCommandId: 'p0',
            targets: TARGETS,
            planOutcomes: [],
          });
          throw new Error('计划后续步骤失败');
        }).catch(() => undefined);
        expect(await begin('w9')).toMatchObject({ executionNo: 1, targetsSealed: false, leaseOwner: 'w9' });
        const other = await setup();
        expect((await other.plan()).state).toMatchObject({ executionNo: 1, targetsSealed: true });
      });

      it('同一计划命令同内容幂等；封存后换内容或换命令 ID 一律 TARGETS_ALREADY_SEALED', async () => {
        const { plan, register, rejects } = await setup();
        const first = await plan();
        expect((await register([], 'plan-1')).pageCommit).toEqual(first.pageCommit);
        await rejects(register([], 'plan-2'), 'TARGETS_ALREADY_SEALED');
        await rejects(register([], 'plan-1', [TARGETS[0]!]), 'TARGETS_ALREADY_SEALED');
      });

      it('未封存时执行页、完成与缺省断言都报 TARGETS_NOT_SEALED；计划事务内可显式不要求封存', async () => {
        const { tx, begin, complete, rejects } = await setup();
        await begin();
        const recordRaw = tx((p, t) =>
          p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 1,
            pageCommandId: page(1),
            items: [item('target', T_G1)],
          }),
        );
        await rejects(recordRaw, 'TARGETS_NOT_SEALED');
        await rejects(complete(), 'TARGETS_NOT_SEALED');
        const active = { ...key, executionNo: 1, leaseOwner: 'w1' };
        await rejects(
          tx((p, t) => p.assertExecutionActive(t, active)),
          'TARGETS_NOT_SEALED',
        );
        await tx((p, t) => p.assertExecutionActive(t, { ...active, requireSealed: false }));
      });

      it('目标键不规范（大写 UUID）或引用不存在的提名：协议违例，整调用不写', async () => {
        const { register, begin, rejects, tx } = await setup();
        await begin();
        const upper = [
          { targetKey: `org:${FX.g1.replace('4000', 'ABCD')}` as const, action: 'append' as const, nominationIds: [] },
        ];
        await rejects(register([], 'plan-1', upper), 'OUTCOME_NOT_ALLOWED');
        const ghost = [{ targetKey: T_G1, action: 'append' as const, nominationIds: [FX.viewer] }];
        await rejects(register([], 'plan-1', ghost), 'OUTCOME_NOT_ALLOWED');
        const state = await tx((p, t) =>
          p.renewLease(t, { ...key, executionNo: 1, leaseOwner: 'w1', leaseSeconds: 60 }),
        );
        expect(state).toMatchObject({ targetsSealed: false, targetCount: 0 });
      });
    });

    describe('SP-11 执行页、提交证明与三个事务边界（SP-19 #5、#15）', () => {
      it('执行页写 execute 提交证明；同页同内容重放返回同一证明；同页换内容 IDEMPOTENCY_CONFLICT；空页与缺目标行违例', async () => {
        const { tx, plan, record, rowOf, rejects } = await setup();
        await plan();
        const commit = await record([item('target', T_G1), item('nomination', FX.n1)]);
        expect(commit).toMatchObject({ kind: 'execute', pageNo: 1, pageCommandId: page(1), rowCount: 2 });
        expect(Object.keys(commit).sort()).toEqual(
          ['committedAt', 'consumer', 'executionNo', 'kind', 'pageCommandId', 'pageNo', 'rowCount', 'runId'].sort(),
        );
        expect(await record([item('target', T_G1), item('nomination', FX.n1)])).toEqual(commit);
        await rejects(record([failed('target', T_G1, 'TARGET_NOT_FOUND')]), 'IDEMPOTENCY_CONFLICT');
        await rejects(record([item('target', T_P1)]), 'IDEMPOTENCY_CONFLICT');
        expect(await rowOf(T_P1)).toMatchObject({ status: 'pending' });
        await rejects(record([], 2), 'OUTCOME_NOT_ALLOWED');
        await rejects(record([item('nomination', FX.n2)], 2), 'OUTCOME_NOT_ALLOWED');
        const wrongId = tx(async (p, t) => {
          await p.assertExecutionActive(t, { ...key, executionNo: 1, leaseOwner: 'w1' });
          return p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 2,
            pageCommandId: page(3),
            items: [item('target', T_P1)],
          });
        });
        await rejects(wrongId, 'OUTCOME_NOT_ALLOWED');
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(2) }))).toBeNull();
      });

      it('#15③ 页执行中租约到期：接管者的 beginConsumption 等本页提交后才生效，本页证明有效，旧执行此后失效', async () => {
        const { h, tx, plan, begin, rowOf, rejects } = await setup();
        await plan([], { leaseSeconds: 30 });
        const reached = gate();
        const release = gate();
        const pageA = tx(async (p, t) => {
          await p.assertExecutionActive(t, { ...key, executionNo: 1, leaseOwner: 'w1' });
          const commit = await p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 1,
            pageCommandId: page(1),
            items: [item('target', T_G1), item('nomination', FX.n1)],
          });
          reached.open();
          await release.wait;
          return commit;
        });
        await reached.wait;
        await h.advance(31);
        const takeover = begin('w2');
        expect(await settledWithin(takeover)).toBe(false); // 等本页持有的 S 锁
        release.open();
        await pageA;
        expect(await takeover).toMatchObject({ executionNo: 2, leaseOwner: 'w2' });
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toMatchObject({
          executionNo: 1,
        });
        expect(await rowOf(T_G1)).toMatchObject({ status: 'synced', executionNo: 1 });
        await rejects(
          tx((p, t) => p.renewLease(t, { ...key, executionNo: 1, leaseOwner: 'w1', leaseSeconds: 30 })),
          'EXECUTION_INACTIVE',
        );
      });

      it('#15③ 页执行中租约到期后本页失败回滚：只回滚本页，接管者已生效的接管不被抹掉', async () => {
        const { h, tx, plan, begin, rowOf } = await setup();
        await plan([], { leaseSeconds: 30 });
        const reached = gate();
        const release = gate();
        const pageA = tx(async (p, t) => {
          await p.assertExecutionActive(t, { ...key, executionNo: 1, leaseOwner: 'w1' });
          await p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 1,
            pageCommandId: page(1),
            items: [item('target', T_G1)],
          });
          reached.open();
          await release.wait;
          throw new Error('本页业务写入失败');
        });
        await reached.wait;
        await h.advance(31);
        const takeover = begin('w2');
        expect(await settledWithin(takeover)).toBe(false);
        release.open();
        await pageA.catch(() => undefined);
        expect(await takeover).toMatchObject({ executionNo: 2 });
        await tx((p, t) => p.assertExecutionActive(t, { ...key, executionNo: 2, leaseOwner: 'w2' }));
        expect(await rowOf(T_G1)).toMatchObject({ status: 'pending' });
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toBeNull();
      });

      it('#15① 执行页持消费记录 S 时管理员终止：终止等页提交，页回执有效，其余行 aborted', async () => {
        const { tx, plan, rowOf } = await setup();
        await plan();
        const reached = gate();
        const release = gate();
        const pageA = tx(async (p, t) => {
          await p.assertExecutionActive(t, { ...key, executionNo: 1, leaseOwner: 'w1' });
          await p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 1,
            pageCommandId: page(1),
            items: [item('target', T_G1), item('nomination', FX.n1)],
          });
          reached.open();
          await release.wait;
        });
        await reached.wait;
        const abort = tx((p, t) =>
          p.abortConsumption(t, { ...key, executionNo: 1, code: 'ABORTED_BY_ADMIN', recovery: 'terminate' }),
        );
        expect(await settledWithin(abort)).toBe(false);
        release.open();
        await pageA;
        expect(await abort).toMatchObject({ status: 'aborted', terminalCode: 'ABORTED_BY_ADMIN' });
        expect(await rowOf(T_G1)).toMatchObject({ status: 'synced' });
        expect(await rowOf(T_P1)).toMatchObject({ status: 'aborted', errorCode: 'ABORTED_BY_ADMIN' });
      });

      it('#15② 完成只在独立终结事务里做：执行页内调用 completeConsumption 是协议违例，页随之回滚', async () => {
        const { tx, plan, record, complete, rowOf, rejects } = await setup();
        await plan(PLAN_SKIPS);
        await record([item('target', T_G1), item('nomination', FX.n1), item('object', FX.o1)]);
        const inPage = tx(async (p, t) => {
          await p.assertExecutionActive(t, { ...key, executionNo: 1, leaseOwner: 'w1' });
          await p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 2,
            pageCommandId: page(2),
            items: [item('target', T_P1), item('nomination', FX.n2), item('org_health', FX.g1)],
          });
          return p.completeConsumption(t, { ...key, executionNo: 1 });
        });
        await rejects(inPage, 'OUTCOME_NOT_ALLOWED');
        expect(await rowOf(T_P1)).toMatchObject({ status: 'pending' });
        await record([item('target', T_P1), item('nomination', FX.n2), item('org_health', FX.g1)], 2);
        expect(await complete()).toMatchObject({ status: 'completed' });
      });

      it('接管后：旧执行留下的提交证明不证明新执行的同号页；旧执行不能再写', async () => {
        const { h, tx, plan, begin, record, rejects } = await setup();
        await plan([], { leaseSeconds: 30 });
        await record([item('target', T_G1)]);
        await h.advance(31);
        await begin('w2');
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toMatchObject({
          executionNo: 1,
        });
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1, 2) }))).toBeNull();
        await rejects(record([item('target', T_P1)], 2, 1), 'EXECUTION_INACTIVE');
        expect(await record([item('target', T_P1)], 1, 2, 'w2')).toMatchObject({ executionNo: 2, pageNo: 1 });
      });
    });

    describe('SP-12 行状态与完成门槛', () => {
      it('终态同值幂等、异值 ROW_FINAL；可重试失败阻止完成，转成功后可完成', async () => {
        const { plan, record, complete, rejects } = await setup();
        await plan(PLAN_SKIPS);
        const storage = { recovery: 'retry_same_run' as const };
        await record([
          item('target', T_G1),
          item('nomination', FX.n1),
          failed('target', T_P1, 'STORAGE_UNAVAILABLE', storage),
        ]);
        await rejects(record([failed('target', T_G1, 'TARGET_NOT_FOUND')], 2), 'ROW_FINAL');
        const aggregate = { errorParams: { codes: ['STORAGE_UNAVAILABLE'], nominationIds: [FX.n2] }, ...storage };
        await record(
          [
            item('target', T_G1),
            failed('nomination', FX.n2, 'STORAGE_UNAVAILABLE', storage),
            failed('object', FX.o1, 'NOMINATIONS_FAILED', aggregate),
            item('org_health', FX.g1),
          ],
          2,
        );
        await rejects(complete(), 'RETRYABLE_ROWS_REMAIN');
        await record([item('target', T_P1), item('nomination', FX.n2), item('object', FX.o1)], 3);
        const done = await complete();
        expect(done).toMatchObject({ status: 'completed' });
        expect(done.counts).toMatchObject({ pending: 0, failed: 0, failedRetry: 0, skipped: 3, synced: 6 });
      });

      it('只有 target 方向提名的对象：对象聚合回执 skipped / direction_target（SP-12 全部 skipped）', async () => {
        const { plan, rowOf } = await setup();
        await plan(PLAN_SKIPS);
        expect(await rowOf(FX.o2)).toMatchObject({ status: 'skipped', errorParams: { reason: 'direction_target' } });
        expect(await rowOf(FX.n3)).toMatchObject({ status: 'skipped' });
      });
    });

    describe('SP-14 回执组合表（SP-19 #16）', () => {
      type Case = [string, 'plan' | 'execute', OutcomeItem, boolean];
      const reason = (value: string) => ({ status: 'skipped' as const, errorParams: { reason: value } });
      const cause = { errorParams: { causeNominationIds: [FX.n2] } };
      const retry = { recovery: 'retry_same_run' as const };
      const aggregate = { errorParams: { codes: ['SUCCESSOR_NOT_ACTIVE'], nominationIds: [FX.n1] } };
      const revoked = (scope: string, ref: string) => ({ errorParams: { scope, ref } });
      const cases: Case[] = [
        ['R1 流程中', 'plan', failed('nomination', FX.n1, 'SUBJECT_IN_PROCESS'), true],
        ['R1 执行期不允许', 'execute', failed('nomination', FX.n1, 'SUBJECT_IN_PROCESS'), false],
        ['R2 准备度映射不到', 'plan', failed('nomination', FX.n1, 'READINESS_UNKNOWN'), true],
        ['R2 不写对象行', 'plan', failed('object', FX.o1, 'READINESS_UNKNOWN'), false],
        ['R3 继任者离职（执行期）', 'execute', failed('nomination', FX.n1, 'SUCCESSOR_NOT_ACTIVE'), true],
        ['R3 准备度停用', 'plan', failed('nomination', FX.n1, 'READINESS_DISABLED'), true],
        ['R3 不写目标行', 'execute', failed('target', T_G1, 'SUCCESSOR_NOT_ACTIVE'), false],
        ['R4 目标不存在', 'plan', failed('target', T_G1, 'TARGET_NOT_FOUND'), true],
        ['R4 目标超范围（提名）', 'execute', failed('nomination', FX.n1, 'TARGET_OUT_OF_SCOPE'), true],
        ['R4 非关键职位（职位目标）', 'plan', failed('target', T_P1, 'TARGET_NOT_KEY_POSITION'), true],
        ['R4 非关键职位（职位提名）', 'plan', failed('nomination', FX.n2, 'TARGET_NOT_KEY_POSITION'), true],
        ['R4 非关键职位不适用组织目标', 'plan', failed('target', T_G1, 'TARGET_NOT_KEY_POSITION'), false],
        ['R4 非关键职位不适用组织提名', 'plan', failed('nomination', FX.n1, 'TARGET_NOT_KEY_POSITION'), false],
        ['R4 非关键职位不适用健康度', 'execute', failed('org_health', FX.g1, 'TARGET_NOT_KEY_POSITION'), false],
        ['R4a 健康度写入范围不足', 'execute', failed('org_health', FX.g1, 'TARGET_OUT_OF_SCOPE'), true],
        ['R4b 健康度组织不存在', 'plan', failed('org_health', FX.g1, 'TARGET_NOT_FOUND'), true],
        ['R5 覆盖目标部分提名失败', 'execute', failed('target', T_G1, 'TARGET_PARTIAL_NOMINATIONS', cause), true],
        ['R5 缺 causeNominationIds', 'execute', failed('target', T_G1, 'TARGET_PARTIAL_NOMINATIONS'), false],
        ['R5 不写对象行', 'plan', failed('object', FX.o1, 'TARGET_PARTIAL_NOMINATIONS', cause), false],
        ['R6 对象撤权', 'plan', failed('object', FX.o1, 'SOURCE_REVOKED', revoked('object', FX.o1)), true],
        [
          'R6 字段撤权（提名）',
          'execute',
          failed('nomination', FX.n1, 'SOURCE_REVOKED', revoked('field', 'potential')),
          true,
        ],
        ['R6 提名不用 org 范围', 'plan', failed('nomination', FX.n1, 'SOURCE_REVOKED', revoked('org', FX.g1)), false],
        ['R7 健康度组织撤权', 'execute', failed('org_health', FX.g1, 'SOURCE_REVOKED', revoked('org', FX.g1)), true],
        ['R7 健康度字段撤权', 'plan', failed('org_health', FX.g1, 'SOURCE_REVOKED', revoked('field', 'levelId')), true],
        [
          'R7 健康度不用 object 范围',
          'plan',
          failed('org_health', FX.g1, 'SOURCE_REVOKED', revoked('object', FX.o1)),
          false,
        ],
        ['R8 健康度等级停用', 'plan', failed('org_health', FX.g1, 'HEALTH_LEVEL_DISABLED'), true],
        ['R8 不写提名行', 'plan', failed('nomination', FX.n1, 'HEALTH_LEVEL_UNKNOWN'), false],
        ['R9 保存点基础设施错误', 'execute', failed('target', T_G1, 'STORAGE_UNAVAILABLE', retry), true],
        ['R9 计划阶段不写', 'plan', failed('target', T_G1, 'STORAGE_UNAVAILABLE', retry), false],
        ['R9 必须可重试', 'execute', failed('target', T_G1, 'STORAGE_UNAVAILABLE'), false],
        ['R10 对象聚合失败', 'plan', failed('object', FX.o1, 'NOMINATIONS_FAILED', aggregate), true],
        ['R10 可重试聚合', 'execute', failed('object', FX.o1, 'NOMINATIONS_FAILED', { ...aggregate, ...retry }), true],
        ['R10 只写对象行', 'plan', failed('nomination', FX.n1, 'NOMINATIONS_FAILED', aggregate), false],
        ['R11 成功', 'plan', item('object', FX.o1), true],
        ['R11 健康度保留手工值', 'execute', item('org_health', FX.g1, { errorParams: { manualKept: true } }), true],
        ['R11 成功不带码', 'execute', item('target', T_G1, { errorCode: 'TARGET_NOT_FOUND' }), false],
        ['R12 跳过 target 方向', 'plan', item('nomination', FX.n3, reason('direction_target')), true],
        ['R12 对象全部为 target 方向', 'plan', item('object', FX.o2, reason('direction_target')), true],
        ['R12 只在计划阶段', 'execute', item('org_health', FX.g2, reason('not_provided')), false],
        ['R12 原因与行种类不符', 'plan', item('org_health', FX.g2, reason('direction_target')), false],
        ['R12 目标行不跳过', 'plan', item('target', T_G1, reason('no_nominations')), false],
        [
          'R13 消费方不写 aborted',
          'plan',
          item('object', FX.o1, { status: 'aborted', errorCode: 'ABORTED_BY_ADMIN' }),
          false,
        ],
        [
          'R14 消费方不写 superseded',
          'execute',
          item('target', T_G1, { status: 'superseded', errorCode: 'RUN_SUPERSEDED' }),
          false,
        ],
        ['pending 只由 T04 预建', 'plan', item('object', FX.o1, { status: 'pending' }), false],
        ['不存在的行', 'plan', item('nomination', FX.viewer), false],
      ];

      it.each(cases)('%s（%s）', async (_label, phase, outcome, allowed) => {
        const { plan, record, rowOf, rejects, tx } = await setup();
        const write =
          phase === 'plan'
            ? plan([outcome])
            : plan().then(() => {
                const extra =
                  outcome.rowKind === 'target' || outcome.rowKind === 'org_health' ? [] : [item('target', T_P1)];
                return record([outcome, ...extra]);
              });
        if (allowed) {
          await write;
          expect(await rowOf(outcome.rowId)).toMatchObject({ status: outcome.status, recovery: outcome.recovery });
          return;
        }
        await rejects(write, 'OUTCOME_NOT_ALLOWED');
        // 整调用不写：计划阶段违例时没有消费记录（计划事务整体回滚）；执行阶段违例时没有执行页证明
        if (phase === 'plan') {
          const state = await tx((p, t) => p.beginConsumption(t, { ...key, leaseOwner: 'w9', leaseSeconds: 60 }));
          expect(state).toMatchObject({ executionNo: 1, targetsSealed: false });
        } else {
          expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toBeNull();
        }
      });

      it('没有提名的对象：计划提交里写 skipped / no_nominations', async () => {
        const { plan, rowOf } = await setup(syncFixture({ withEmptyObject: true }));
        await plan([...PLAN_SKIPS, skipped('object', FX.o3, 'no_nominations')]);
        expect(await rowOf(FX.o3)).toMatchObject({ status: 'skipped', errorParams: { reason: 'no_nominations' } });
      });
    });

    describe('SP-13 终止与 SP-04 取代（SP-19 #9、#13、#14、#17）', () => {
      it('管理员终止：租约过期也允许；剩余行 aborted；终态幂等不改码；之后写入一律失效', async () => {
        const { h, tx, plan, record, complete, rowOf, rejects } = await setup();
        await plan([], { leaseSeconds: 30 });
        await record([item('target', T_G1), item('nomination', FX.n1)]);
        await h.advance(31);
        const abort = (abortCode: 'ABORTED_BY_ADMIN' | 'SCOPE_REQUIRED', recovery: 'terminate' | 'new_run') =>
          tx((p, t) => p.abortConsumption(t, { ...key, executionNo: 1, code: abortCode, recovery }));
        await rejects(abort('ABORTED_BY_ADMIN', 'new_run'), 'OUTCOME_NOT_ALLOWED');
        const state = await abort('ABORTED_BY_ADMIN', 'terminate');
        expect(state).toMatchObject({
          status: 'aborted',
          terminalCode: 'ABORTED_BY_ADMIN',
          terminalRecovery: 'terminate',
        });
        expect(await abort('ABORTED_BY_ADMIN', 'terminate')).toMatchObject({ terminalCode: 'ABORTED_BY_ADMIN' });
        expect(await rowOf(T_G1)).toMatchObject({ status: 'synced' });
        expect(await rowOf(T_P1)).toMatchObject({ status: 'aborted', errorCode: 'ABORTED_BY_ADMIN' });
        await rejects(complete(), 'EXECUTION_INACTIVE');
      });

      it('C 类拒绝：只能在尚无消费记录时以 executionNo = null 终止，四类预建行全部 aborted', async () => {
        const { tx, outcomes, begin } = await setup();
        const state = await tx((p, t) =>
          p.abortConsumption(t, { ...key, executionNo: null, code: 'ACTOR_SCOPE_EXCEEDED', recovery: 'new_run' }),
        );
        expect(state).toMatchObject({ status: 'aborted', terminalRecovery: 'new_run', targetsSealed: false });
        const rows = (await outcomes()).items;
        expect(rows).toHaveLength(7);
        expect(rows.every((row) => row.status === 'aborted' && row.errorCode === 'ACTOR_SCOPE_EXCEEDED')).toBe(true);
        expect(await begin()).toMatchObject({ status: 'aborted' }); // 终态 → 返回终态，调用方停止
      });

      it('C 类码不能终止已有执行；null 执行序号只用于 C 类（SP-13）', async () => {
        const { tx, plan, record, rowOf, rejects } = await setup();
        await plan();
        await record([item('target', T_G1)]);
        for (const cClass of ['SCOPE_REQUIRED', 'ACTOR_SCOPE_EXCEEDED', 'UNSUPPORTED_TRIGGER'] as const) {
          const withExecution = tx((p, t) =>
            p.abortConsumption(t, { ...key, executionNo: 1, code: cClass, recovery: 'new_run' }),
          );
          await rejects(withExecution, 'OUTCOME_NOT_ALLOWED');
          const withNull = tx((p, t) =>
            p.abortConsumption(t, { ...key, executionNo: null, code: cClass, recovery: 'new_run' }),
          );
          await rejects(withNull, 'EXECUTION_INACTIVE');
        }
        expect(await rowOf(T_P1)).toMatchObject({ status: 'pending' });
        const fresh = await setup();
        const adminNull = fresh.tx((p, t) =>
          p.abortConsumption(t, { ...key, executionNo: null, code: 'ABORTED_BY_ADMIN', recovery: 'terminate' }),
        );
        await fresh.rejects(adminNull, 'OUTCOME_NOT_ALLOWED');
        expect(await fresh.begin()).toMatchObject({ status: 'running', executionNo: 1 });
      });

      it('项目重启取代：非终态行 superseded，已终态行不动；之后断言与写入报 RUN_SUPERSEDED', async () => {
        const { h, tx, plan, record, rowOf, rejects } = await setup();
        await plan();
        await record([item('target', T_G1), item('nomination', FX.n1)]);
        await h.supersede(FX.run);
        expect(await rowOf(FX.n1)).toMatchObject({ status: 'synced' });
        expect(await rowOf(T_P1)).toMatchObject({ status: 'superseded', errorCode: 'RUN_SUPERSEDED' });
        expect((await tx((p, t) => p.loadRun(t, key)))?.status).toBe('superseded');
        await rejects(
          tx((p, t) => p.assertExecutionActive(t, { ...key, executionNo: 1, leaseOwner: 'w1' })),
          'RUN_SUPERSEDED',
        );
        await rejects(
          tx((p, t) =>
            p.recordOutcome(t, {
              ...key,
              executionNo: 1,
              pageNo: 2,
              pageCommandId: page(2),
              items: [item('target', T_P1)],
            }),
          ),
          'RUN_SUPERSEDED',
        );
        const aborted = tx((p, t) =>
          p.abortConsumption(t, { ...key, executionNo: 1, code: 'ABORTED_BY_ADMIN', recovery: 'terminate' }),
        );
        expect(await aborted).toMatchObject({ status: 'superseded', terminalCode: 'RUN_SUPERSEDED' });
      });

      it('#17 健康度目标写入范围被收回：该行失败，健康度不变，同页其他目标写入，以 partial 完成', async () => {
        const { tx, plan, record, complete, rowOf } = await setup();
        await plan(PLAN_SKIPS);
        await record([
          item('target', T_G1),
          item('nomination', FX.n1),
          item('target', T_P1),
          item('nomination', FX.n2),
          item('object', FX.o1),
          failed('org_health', FX.g1, 'TARGET_OUT_OF_SCOPE'),
        ]);
        for (const rowId of [T_G1, T_P1, FX.n1, FX.n2, FX.o1]) {
          expect(await rowOf(rowId), rowId).toMatchObject({ status: 'synced', pageCommandId: page(1) });
        }
        expect(await rowOf(FX.g1)).toMatchObject({
          status: 'failed',
          errorCode: 'TARGET_OUT_OF_SCOPE',
          recovery: 'none',
        });
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toMatchObject({
          kind: 'execute',
        });
        const done = await complete();
        expect(done.counts).toMatchObject({ pending: 0, failed: 1, failedRetry: 0, skipped: 3 });
        const [health] = await tx((p, t) =>
          p.readOrgHealthRows(t, {
            tenantId: FX.tenant,
            context: { projectId: FX.project, meetingId: null },
            orgIds: [FX.g1],
            viewer: { kind: 'principal', userId: FX.principal },
          }),
        );
        expect(health).toMatchObject({ status: 'value', levelId: FX.readyNow, manual: true, revision: 3 });
      });
    });

    describe('SP-06 三档选择器与无 run 读取（按 viewer 当前授权）', () => {
      const asOf = '2026-10-09';
      const viewer = { kind: 'user' as const, userId: FX.viewer };

      it('会议上下文只取会中对象，不在会中落到当前项目；没有进行中项目取最近结束的（结束日最近者）', async () => {
        const { h, tx } = await setup();
        const read = (context: object) =>
          tx((p, t) =>
            p.readReviewFields(t, {
              tenantId: FX.tenant,
              employeeIds: [FX.e1, FX.e2],
              fieldCodes: ['potential'],
              context: { asOf, ...context },
              viewer,
            }),
          );
        const inMeeting = await read({ triggerMeetingId: FX.meeting, triggerProjectId: FX.oldProject });
        expect(inMeeting.get(FX.e2)).toMatchObject({
          source: { tier: 1, meetingId: FX.meeting },
          values: { potential: { value: 'low' } },
        });
        expect(inMeeting.get(FX.e1)).toMatchObject({
          source: { tier: 2, projectId: FX.project },
          values: { potential: { value: 'high' } },
        });
        const beforeCurrent = await read({ asOf: '2026-08-01' });
        expect(beforeCurrent.get(FX.e1)).toMatchObject({
          source: { tier: 3, projectId: FX.oldProject },
          values: { potential: { value: 'mid' } },
        });
        const earlier = await read({ asOf: '2026-05-01' });
        expect(earlier.get(FX.e1)).toMatchObject({ source: { tier: 3, projectId: FX.olderProject } });
        const history = await read({ asOf: '2025-12-31' });
        expect(history.get(FX.e1)).toMatchObject({ source: null, values: { potential: { status: 'unavailable' } } });
        await h.denyViewer(FX.viewer, { fieldCodes: ['potential'], employeeIds: [FX.e2] });
        const denied = await read({});
        expect(denied.get(FX.e1)?.values.potential).toEqual({ status: 'forbidden', value: null });
        expect(denied.get(FX.e2)).toMatchObject({ source: null, values: { potential: { status: 'forbidden' } } });
      });

      it('继任读取：区分 module_absent 与零提名；组织 / 职位聚合只取 successor 方向的对应提名', async () => {
        const { tx } = await setup();
        const context = { asOf: '2026-07-15', triggerProjectId: FX.oldProject };
        const entries = await tx((p, t) =>
          p.readSuccessionEntries(t, { tenantId: FX.tenant, employeeIds: [FX.e1], context, viewer }),
        );
        expect(entries[0]).toMatchObject({ status: 'module_absent', source: { tier: 1, projectId: FX.oldProject } });
        const current = await tx((p, t) =>
          p.readSuccessionEntries(t, {
            tenantId: FX.tenant,
            employeeIds: [FX.e2],
            orgIds: [FX.g1],
            positionIds: [FX.p1],
            context: { asOf },
            viewer,
          }),
        );
        expect(current.map((entry) => [entry.status, entry.nominations.map((n) => n.nominationId)])).toEqual([
          ['value', []],
          ['value', [FX.n1]],
          ['value', [FX.n2]],
        ]);
        expect(current[2]).toMatchObject({ positionId: FX.p1, employeeId: null, orgId: null, source: { tier: 2 } });
      });

      it('继任读取按 viewer 裁剪：提名表单字段逐个 forbidden，撤了源员工的提名不进组织 / 职位聚合', async () => {
        const { h, tx } = await setup();
        await h.denyViewer(FX.viewer, { fieldCodes: ['remark'] });
        const trimmed = await tx((p, t) =>
          p.readSuccessionEntries(t, { tenantId: FX.tenant, orgIds: [FX.g1], context: { asOf }, viewer }),
        );
        expect(trimmed[0]?.nominations[0]?.formValues).toEqual({ remark: { status: 'forbidden', value: null } });
        await h.denyViewer(FX.viewer, { employeeIds: [FX.e1] });
        const aggregated = await tx((p, t) =>
          p.readSuccessionEntries(t, {
            tenantId: FX.tenant,
            orgIds: [FX.g1],
            positionIds: [FX.p1],
            context: { asOf },
            viewer,
          }),
        );
        expect(aggregated.map((entry) => entry.nominations.length)).toEqual([0, 0]);
      });

      it('绿化率按 viewer 当前授权：组织无权 forbidden（不带数值与来源），员工无权不计入分子分母；分母 0 为 null', async () => {
        const { h, tx } = await setup();
        const rate = () =>
          tx((p, t) => p.greenRate(t, { tenantId: FX.tenant, orgIds: [FX.g1, FX.g2], context: { asOf }, viewer }));
        const all = await rate();
        expect(all.get(FX.g1)).toMatchObject({
          status: 'value',
          green: 1,
          placed: 2,
          rate: 0.5,
          source: { matrixId: FX.matrix },
        });
        expect(all.get(FX.g2)).toMatchObject({ status: 'unavailable', placed: 0, rate: null, source: null });
        await h.denyViewer(FX.viewer, { employeeIds: [FX.e1] });
        expect((await rate()).get(FX.g1)).toMatchObject({ status: 'value', green: 0, placed: 1, rate: 0 });
        await h.denyViewer(FX.viewer, { orgIds: [FX.g1] });
        expect((await rate()).get(FX.g1)).toEqual({
          status: 'forbidden',
          green: 0,
          placed: 0,
          rate: null,
          source: null,
        });
      });

      it('字段目录：多选字段不参与公式（SP-17）；准备度按排序号列出全部（含停用）', async () => {
        const { tx } = await setup();
        const fields = await tx((p, t) => p.listReviewFields(t, { tenantId: FX.tenant }));
        expect(fields.find((field) => field.code === 'tags')).toMatchObject({
          kind: 'multi_option',
          formulaUsable: false,
        });
        const levels = await tx((p, t) => p.listReadinessLevels(t, { tenantId: FX.tenant }));
        expect(levels.map((level) => [level.code, level.enabled])).toEqual([
          ['RN1', true],
          ['RN3', false],
        ]);
      });
    });

    describe('SP-15 / SP-16 健康度回写（SP-19 #10、#11）', () => {
      const context = { projectId: FX.project, meetingId: null };
      const viewer = { kind: 'user' as const, userId: FX.viewer };
      const row = (orgId: string, expectedRevision: number) => ({
        orgId,
        levelId: FX.readyLater,
        levelCode: 'H2',
        status: 'value' as const,
        expectedRevision,
      });
      const ZERO = { currentRevision: 0, currentLevelId: null, currentManual: false };

      it('读取：无读权只给 forbidden（不带版本与值）；无行 revision = 0', async () => {
        const { h, tx } = await setup();
        await h.denyViewer(FX.viewer, { orgIds: [FX.g2] });
        const rows = await tx((p, t) =>
          p.readOrgHealthRows(t, { tenantId: FX.tenant, context, orgIds: [FX.g1, FX.g2], viewer }),
        );
        expect(rows[0]).toMatchObject({ status: 'value', manual: true, revision: 3 });
        expect(rows[1]).toEqual({ status: 'forbidden', orgId: FX.g2, context });
        const other = await tx((p, t) =>
          p.readOrgHealthRows(t, {
            tenantId: FX.tenant,
            context,
            orgIds: [FX.g2],
            viewer: { kind: 'principal', userId: FX.principal },
          }),
        );
        expect(other[0]).toEqual({ status: 'absent', orgId: FX.g2, context, revision: 0 });
      });

      it('计算回写：手动值保留（优先于版本）；版本不符冲突且不改；台账按完整命令指纹幂等，换主体或计算 run 冲突', async () => {
        const { tx, rejects } = await setup();
        const credential = {
          kind: 'compute' as const,
          principalUserId: FX.principal,
          calcRunId: FX.run,
          commandId: 'c1',
        };
        const write = (rows: ReturnType<typeof row>[], extra: Partial<typeof credential> = {}) =>
          tx((p, t) =>
            p.recordOrgHealth(t, { tenantId: FX.tenant, context, credential: { ...credential, ...extra }, rows }),
          );
        const receipt = await write([row(FX.g2, 1), row(FX.g1, 0)]);
        expect(receipt.items.map((i) => [i.orgId, i.outcome])).toEqual([
          [FX.g1, 'MANUAL_KEPT'],
          [FX.g2, 'REVISION_CONFLICT'],
        ]);
        expect(receipt.items[1]).toMatchObject(ZERO);
        expect(await write([row(FX.g2, 1), row(FX.g1, 0)])).toEqual(receipt);
        await rejects(write([row(FX.g2, 0)]), 'IDEMPOTENCY_CONFLICT');
        await rejects(write([row(FX.g2, 1), row(FX.g1, 0)], { principalUserId: FX.writer }), 'IDEMPOTENCY_CONFLICT');
        await rejects(write([row(FX.g2, 1), row(FX.g1, 0)], { calcRunId: FX.project }), 'IDEMPOTENCY_CONFLICT');
        const ok = await write([row(FX.g2, 0)], { commandId: 'c2' });
        expect(ok.items[0]).toMatchObject({ outcome: 'written', currentRevision: 1, currentManual: false });
      });

      it('重置覆盖手动值且原子写 computed；重置期间他人手工赋值 → 冲突、手工值保留', async () => {
        const { tx } = await setup();
        const reset = (expectedRevision: number, commandId: string) =>
          tx((p, t) =>
            p.resetOrgHealth(t, {
              tenantId: FX.tenant,
              context,
              credential: { kind: 'reset', userId: FX.writer, commandId },
              rows: [row(FX.g1, expectedRevision)],
            }),
          );
        const assign = await tx((p, t) =>
          p.recordOrgHealth(t, {
            tenantId: FX.tenant,
            context,
            credential: { kind: 'assign', userId: FX.writer, commandId: 'a1' },
            rows: [row(FX.g1, 3)],
          }),
        );
        expect(assign.items[0]).toMatchObject({ outcome: 'written', currentRevision: 4, currentManual: true });
        expect((await reset(3, 'r1')).items[0]).toMatchObject({ outcome: 'REVISION_CONFLICT', currentManual: true });
        expect((await reset(4, 'r2')).items[0]).toMatchObject({
          outcome: 'written',
          currentRevision: 5,
          currentManual: false,
        });
        const [state] = await tx((p, t) =>
          p.readOrgHealthRows(t, {
            tenantId: FX.tenant,
            context,
            orgIds: [FX.g1],
            viewer: { kind: 'principal', userId: FX.principal },
          }),
        );
        expect(state).toMatchObject({ method: 'computed', manual: false });
      });

      it('逐组织授权先于台账：缺按钮 FORBIDDEN、组织不在范围 OUT_OF_SCOPE，拒绝行不带真实等级 / 版本 / 手动标记', async () => {
        const { h, tx } = await setup();
        const assign = (userId: string, commandId: string) =>
          tx((p, t) =>
            p.recordOrgHealth(t, {
              tenantId: FX.tenant,
              context,
              credential: { kind: 'assign', userId, commandId },
              rows: [row(FX.g1, 3), row(FX.g2, 0)],
            }),
          );
        await h.denyHealthWrite(FX.viewer, { forbidden: true });
        await h.denyHealthWrite(FX.actor, { orgIds: [FX.g2] });
        const denied = await assign(FX.viewer, 'x1');
        expect(denied.items).toEqual([
          { orgId: FX.g1, outcome: 'FORBIDDEN', ...ZERO },
          { orgId: FX.g2, outcome: 'FORBIDDEN', ...ZERO },
        ]);
        const partial = await assign(FX.actor, 'x2');
        expect(partial.items.map((i) => i.outcome)).toEqual(['written', 'OUT_OF_SCOPE']);
        expect(partial.items[1]).toMatchObject(ZERO);
        // 撤权后原命令重放：按当前授权重新判定，不再返回 written 与真实值
        await h.denyHealthWrite(FX.actor, { forbidden: true });
        expect((await assign(FX.actor, 'x2')).items).toEqual([
          { orgId: FX.g1, outcome: 'FORBIDDEN', ...ZERO },
          { orgId: FX.g2, outcome: 'FORBIDDEN', ...ZERO },
        ]);
        await h.endProject(FX.project);
        expect((await assign(FX.writer, 'x3')).items.map((i) => i.outcome)).toEqual(['PROJECT_ENDED', 'PROJECT_ENDED']);
      });
    });
  });
}
