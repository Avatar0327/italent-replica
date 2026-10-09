/**
 * 同步端口共用契约测试（《R3-T04/T05 同步协议》SP-18）：runSyncPortContractSuite(name, factory) 对替身与真实实现跑
 * 同一套用例，覆盖 SP-02～SP-17 的规则、SP-14 回执组合表（R1～R14、R4a、R4b 的正反例）与 SP-19 中 T04 契约套件承担的
 * 交错（5、6、9、12、13、14、15③、16、17 的契约部分；10、11 健康度）。T05 只加用例，不另定类型。
 * 夹具（syncFixture）是协议层面的场景描述：真实实现的工厂按它落库（冻结表、来源项目、健康度行），并提供同一组控制
 * （撤权、取代、拨时钟）。本文件末尾对替身跑一遍。
 */
import type { Tx } from '@italent/db';
import {
  SYNC_ERROR_CODES,
  type OutcomeItem,
  type SyncNomination,
  type SyncTargetRegistration,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryTalentReviewSyncPort,
  type InMemorySyncData,
  type InMemorySyncPort,
} from './sync-port-memory.js';
import type { TalentReviewSyncPort } from './sync-port.js';

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
  o1: id(11),
  o2: id(12),
  e1: id(21),
  e2: id(22),
  e3: id(23),
  n1: id(31),
  n2: id(32),
  n3: id(33),
  g1: id(41),
  g2: id(42),
  p1: id(51),
  meeting: id(61),
  oldProject: id(62),
  newProject: id(63),
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
  formValues: {},
  ...extra,
});

/** 一个 run：O1（流程结束，两条 successor 提名：组织 G1、职位 P1），O2（流程中，一条 target 提名），健康度 G1 有值、G2 未提供。 */
export function syncFixture(): InMemorySyncData {
  const n1 = nomination(FX.n1, {});
  const n2 = nomination(FX.n2, { kind: 'position', orgId: null, positionId: FX.p1, sortNo: 2 });
  const n3 = nomination(FX.n3, {
    objectId: FX.o2,
    employeeId: FX.e2,
    direction: 'target',
    successorEmployeeId: FX.e2,
    syncEligible: false,
  });
  const object = (objectId: string, employeeId: string, inFlow: boolean) => ({
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
  const health = (orgId: string, status: 'value' | 'not_provided') => ({
    orgId,
    meetingId: null,
    levelId: status === 'value' ? FX.readyNow : null,
    levelCode: status === 'value' ? 'H1' : null,
    manual: false,
    status,
    succession: { status: 'present' as const, count: 0, nominations: [] },
  });
  const source = (
    projectId: string,
    extra: Partial<InMemorySyncData['sources'] extends readonly (infer S)[] | undefined ? S : never>,
  ) => ({
    projectId,
    meetingId: null,
    code: projectId,
    status: 'in_progress' as const,
    periodStartDate: '2026-01-01',
    periodEndDate: '2026-12-31',
    businessDate: null,
    objects: [],
    ...extra,
  });
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
          objectCount: 2,
          nominationCount: 3,
          orgHealthCount: 2,
          excludedCount: 0,
        },
        objects: [object(FX.o1, FX.e1, false), object(FX.o2, FX.e2, true)],
        nominations: [n1, n2, n3],
        orgHealth: [health(FX.g1, 'value'), health(FX.g2, 'not_provided')],
      },
    ],
    fields: [
      { code: 'potential', label: '潜力', group: '结果', kind: 'option', systemWritten: false, formulaUsable: true },
      { code: 'tags', label: '标签', group: '结果', kind: 'multi_option', systemWritten: false, formulaUsable: true },
    ],
    sources: [
      source(FX.oldProject, {
        status: 'ended',
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
        businessDate: '2026-09-01',
        objects: [
          {
            employeeId: FX.e1,
            orgId: FX.g1,
            fields: { potential: { status: 'value', value: 'high' } },
            succession: [n1],
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
const NOW = FROZEN;
const item = (rowKind: OutcomeItem['rowKind'], rowId: string, extra: Partial<OutcomeItem> = {}): OutcomeItem => ({
  rowKind,
  rowId,
  status: 'synced',
  recovery: 'none',
  executionNo: null,
  pageCommandId: null,
  updatedAt: NOW,
  ...extra,
});
const failed = (rowKind: OutcomeItem['rowKind'], rowId: string, errorCode: OutcomeItem['errorCode'], extra = {}) =>
  item(rowKind, rowId, { status: 'failed', errorCode, ...extra });
const TARGETS: readonly SyncTargetRegistration[] = [
  { targetKey: T_G1, action: 'overwrite', nominationIds: [FX.n1] },
  { targetKey: T_P1, action: 'append', nominationIds: [FX.n2] },
];
const page = (no: number, executionNo = 1) => `${FX.run}:succession:${executionNo}:${no}`;
const code = (error: unknown) => (error as { code?: string }).code;

export function runSyncPortContractSuite(name: string, factory: SyncPortFactory): void {
  const setup = async (fixture = syncFixture()) => {
    const h = await factory(fixture);
    const tx = <T>(work: (port: TalentReviewSyncPort, tx: Tx) => Promise<T>) => h.transaction((t) => work(h.port, t));
    const begin = (leaseOwner = 'w1', leaseSeconds = 60) =>
      tx((p, t) => p.beginConsumption(t, { ...key, leaseOwner, leaseSeconds }));
    const plan = (planOutcomes: OutcomeItem[] = [], planCommandId = 'plan-1', targets = TARGETS, executionNo = 1) =>
      tx((p, t) => p.registerTargets(t, { ...key, executionNo, planCommandId, targets, planOutcomes }));
    const record = (items: OutcomeItem[], pageNo = 1, executionNo = 1) =>
      tx((p, t) =>
        p.recordOutcome(t, { ...key, executionNo, pageNo, pageCommandId: page(pageNo, executionNo), items }),
      );
    const outcomes = () => tx((p, t) => p.getOutcomes(t, { ...key, limit: 2000 }));
    const rejects = async (promise: Promise<unknown>, expected: string) => {
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(code(error), `应拒绝为 ${expected}`).toBe(expected);
    };
    return { h, tx, begin, plan, record, outcomes, rejects };
  };

  describe(`${name}：同步端口契约（SP-18）`, () => {
    describe('SP-02 / SP-05 / SP-06 冻结快照读取', () => {
      it('run 头只在本租户可见；对象按 objectId 分页，超过每页上限拒绝', async () => {
        const { tx } = await setup();
        expect(await tx((p, t) => p.loadRun(t, key))).toMatchObject({ runId: FX.run, trigger: 'sync_requested' });
        expect(await tx((p, t) => p.loadRun(t, { ...key, tenantId: FX.viewer }))).toBeNull();
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
        for (const expected of ['OUTCOME_NOT_ALLOWED', 'NOMINATIONS_FAILED', 'TARGETS_NOT_SEALED', 'RUN_SUPERSEDED']) {
          expect(SYNC_ERROR_CODES).toContain(expected);
        }
        expect(SYNC_ERROR_CODES).not.toContain('LEASE_LOST');
        expect(SYNC_ERROR_CODES).not.toContain('SOURCE_FORBIDDEN');
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
        const { tx, begin, plan, outcomes, rejects } = await setup();
        await begin();
        const { state, pageCommit } = await plan();
        expect(pageCommit).toMatchObject({
          kind: 'plan',
          pageNo: 0,
          pageCommandId: page(0),
          executionNo: 1,
          rowCount: 0,
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
        await rejects(
          tx((p, t) => p.completeConsumption(t, { ...key, executionNo: 1 })),
          'PENDING_ROWS_REMAIN',
        );
      });

      it('同一计划命令同内容幂等；封存后换内容或换命令 ID 一律 TARGETS_ALREADY_SEALED', async () => {
        const { begin, plan, rejects } = await setup();
        await begin();
        const first = await plan();
        expect((await plan()).pageCommit).toEqual(first.pageCommit);
        await rejects(plan([], 'plan-2'), 'TARGETS_ALREADY_SEALED');
        await rejects(plan([], 'plan-1', [TARGETS[0]!]), 'TARGETS_ALREADY_SEALED');
      });

      it('未封存时执行页、完成与缺省断言都报 TARGETS_NOT_SEALED；计划事务内可显式不要求封存', async () => {
        const { tx, begin, record, rejects } = await setup();
        await begin();
        await rejects(record([item('target', T_G1)]), 'TARGETS_NOT_SEALED');
        await rejects(
          tx((p, t) => p.completeConsumption(t, { ...key, executionNo: 1 })),
          'TARGETS_NOT_SEALED',
        );
        const active = { ...key, executionNo: 1, leaseOwner: 'w1' };
        await rejects(
          tx((p, t) => p.assertExecutionActive(t, active)),
          'TARGETS_NOT_SEALED',
        );
        await tx((p, t) => p.assertExecutionActive(t, { ...active, requireSealed: false }));
      });

      it('目标键不规范（大写 UUID）或引用不存在的提名：协议违例，整调用不写', async () => {
        const { tx, begin, plan, rejects } = await setup();
        await begin();
        const upper = [
          { targetKey: `org:${FX.g1.replace('4000', 'ABCD')}` as const, action: 'append' as const, nominationIds: [] },
        ];
        await rejects(plan([], 'plan-1', upper), 'OUTCOME_NOT_ALLOWED');
        const ghost = [{ targetKey: T_G1, action: 'append' as const, nominationIds: [FX.viewer] }];
        await rejects(plan([], 'plan-1', ghost), 'OUTCOME_NOT_ALLOWED');
        const state = await tx((p, t) => p.beginConsumption(t, { ...key, leaseOwner: 'w1', leaseSeconds: 60 })).catch(
          () => null,
        );
        expect(state).toBeNull(); // 租约仍有效：没有因失败调用改变消费记录
      });
    });

    describe('SP-11 执行页与提交证明（SP-19 #5、#15③）', () => {
      it('执行页写 execute 提交证明；同页重放返回同一证明；空页与缺目标行的页被拒', async () => {
        const { tx, begin, plan, record, rejects } = await setup();
        await begin();
        await plan();
        const commit = await record([item('target', T_G1), item('nomination', FX.n1)]);
        expect(commit).toMatchObject({ kind: 'execute', pageNo: 1, pageCommandId: page(1), rowCount: 2 });
        expect(await record([item('target', T_G1), item('nomination', FX.n1)])).toEqual(commit);
        await rejects(record([], 2), 'OUTCOME_NOT_ALLOWED');
        await rejects(record([item('nomination', FX.n2)], 2), 'OUTCOME_NOT_ALLOWED');
        const wrongId = tx((p, t) =>
          p.recordOutcome(t, {
            ...key,
            executionNo: 1,
            pageNo: 2,
            pageCommandId: page(3),
            items: [item('target', T_P1)],
          }),
        );
        await rejects(wrongId, 'OUTCOME_NOT_ALLOWED');
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(2) }))).toBeNull();
      });

      it('接管后：旧执行留下的提交证明不证明新执行的同号页；旧执行不能再写', async () => {
        const { h, tx, begin, plan, record, rejects } = await setup();
        await begin('w1', 30);
        await plan();
        await record([item('target', T_G1)]);
        await h.advance(31);
        await begin('w2');
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toMatchObject({
          executionNo: 1,
        });
        expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1, 2) }))).toBeNull();
        await rejects(record([item('target', T_P1)], 2, 1), 'EXECUTION_INACTIVE');
        expect(await record([item('target', T_P1)], 1, 2)).toMatchObject({ executionNo: 2, pageNo: 1 });
      });
    });

    describe('SP-12 行状态与完成门槛', () => {
      it('终态同值幂等、异值 ROW_FINAL；可重试失败阻止完成，转成功后可完成', async () => {
        const { tx, begin, plan, record, rejects } = await setup();
        await begin();
        const skips = [
          item('nomination', FX.n3, { status: 'skipped', errorParams: { reason: 'direction_target' } }),
          item('object', FX.o2, { status: 'skipped', errorParams: { reason: 'object_terminated' } }),
          item('org_health', FX.g2, { status: 'skipped', errorParams: { reason: 'not_provided' } }),
        ];
        await plan(skips);
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
        await rejects(
          tx((p, t) => p.completeConsumption(t, { ...key, executionNo: 1 })),
          'RETRYABLE_ROWS_REMAIN',
        );
        await record([item('target', T_P1), item('nomination', FX.n2), item('object', FX.o1)], 3);
        const done = await tx((p, t) => p.completeConsumption(t, { ...key, executionNo: 1 }));
        expect(done).toMatchObject({ status: 'completed' });
        expect(done.counts).toMatchObject({ pending: 0, failed: 0, failedRetry: 0, skipped: 3, synced: 6 });
      });
    });

    describe('SP-14 回执组合表（SP-19 #16）', () => {
      type Case = [string, 'plan' | 'execute', OutcomeItem, boolean];
      const reason = (value: string) => ({ status: 'skipped' as const, errorParams: { reason: value } });
      const cause = { errorParams: { causeNominationIds: [FX.n2] } };
      const retry = { recovery: 'retry_same_run' as const };
      const aggregate = { errorParams: { codes: ['SUCCESSOR_NOT_ACTIVE'], nominationIds: [FX.n1] } };
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
        [
          'R6 对象撤权',
          'plan',
          failed('object', FX.o1, 'SOURCE_REVOKED', { errorParams: { scope: 'object', ref: FX.o1 } }),
          true,
        ],
        [
          'R6 字段撤权（提名）',
          'execute',
          failed('nomination', FX.n1, 'SOURCE_REVOKED', { errorParams: { scope: 'field', ref: 'potential' } }),
          true,
        ],
        [
          'R6 提名不用 org 范围',
          'plan',
          failed('nomination', FX.n1, 'SOURCE_REVOKED', { errorParams: { scope: 'org', ref: FX.g1 } }),
          false,
        ],
        [
          'R7 健康度组织撤权',
          'execute',
          failed('org_health', FX.g1, 'SOURCE_REVOKED', { errorParams: { scope: 'org', ref: FX.g1 } }),
          true,
        ],
        [
          'R7 健康度不用 object 范围',
          'plan',
          failed('org_health', FX.g1, 'SOURCE_REVOKED', { errorParams: { scope: 'object', ref: FX.o1 } }),
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
        ['R12 无提名对象', 'plan', item('object', FX.o2, reason('no_nominations')), true],
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
        const { begin, plan, record, outcomes, rejects, tx } = await setup();
        await begin();
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
          const stored = (await outcomes()).items.find(
            (row) => row.rowKind === outcome.rowKind && row.rowId === outcome.rowId,
          );
          expect(stored).toMatchObject({ status: outcome.status, recovery: outcome.recovery });
          return;
        }
        await rejects(write, 'OUTCOME_NOT_ALLOWED');
        const state = await tx((p, t) =>
          p.renewLease(t, { ...key, executionNo: 1, leaseOwner: 'w1', leaseSeconds: 60 }),
        );
        // 整调用不写：计划阶段违例时目标没有封存；执行阶段违例时没有执行页证明
        if (phase === 'plan') expect(state.targetsSealed).toBe(false);
        else expect(await tx((p, t) => p.getPageCommit(t, { ...key, pageCommandId: page(1) }))).toBeNull();
      });
    });

    describe('SP-13 终止与 SP-04 取代（SP-19 #9、#13、#14、#17）', () => {
      it('管理员终止：租约过期也允许；剩余行 aborted；终态幂等不改码；之后写入一律失效', async () => {
        const { h, tx, begin, plan, record, outcomes, rejects } = await setup();
        await begin('w1', 30);
        await plan();
        await record([item('target', T_G1), item('nomination', FX.n1)]);
        await h.advance(31);
        const abort = (code: 'ABORTED_BY_ADMIN' | 'SCOPE_REQUIRED', recovery: 'terminate' | 'new_run') =>
          tx((p, t) => p.abortConsumption(t, { ...key, executionNo: 1, code, recovery }));
        await rejects(abort('ABORTED_BY_ADMIN', 'new_run'), 'OUTCOME_NOT_ALLOWED');
        const state = await abort('ABORTED_BY_ADMIN', 'terminate');
        expect(state).toMatchObject({
          status: 'aborted',
          terminalCode: 'ABORTED_BY_ADMIN',
          terminalRecovery: 'terminate',
        });
        expect(await abort('SCOPE_REQUIRED', 'new_run')).toMatchObject({ terminalCode: 'ABORTED_BY_ADMIN' });
        const rows = (await outcomes()).items;
        expect(rows.find((row) => row.rowId === T_G1)).toMatchObject({ status: 'synced' });
        expect(rows.find((row) => row.rowId === T_P1)).toMatchObject({
          status: 'aborted',
          errorCode: 'ABORTED_BY_ADMIN',
        });
        await rejects(
          tx((p, t) => p.completeConsumption(t, { ...key, executionNo: 1 })),
          'EXECUTION_INACTIVE',
        );
      });

      it('C 类拒绝：尚无消费记录时以 executionNo = null 终止，四类预建行全部 aborted；已有记录时不允许 null', async () => {
        const { tx, outcomes, begin, rejects } = await setup();
        const state = await tx((p, t) =>
          p.abortConsumption(t, { ...key, executionNo: null, code: 'ACTOR_SCOPE_EXCEEDED', recovery: 'new_run' }),
        );
        expect(state).toMatchObject({ status: 'aborted', terminalRecovery: 'new_run', targetsSealed: false });
        const rows = (await outcomes()).items;
        expect(rows).toHaveLength(7);
        expect(rows.every((row) => row.status === 'aborted' && row.errorCode === 'ACTOR_SCOPE_EXCEEDED')).toBe(true);
        expect(await begin()).toMatchObject({ status: 'aborted' }); // 终态 → 返回终态，调用方停止
        const other = await setup();
        await other.begin();
        await rejects(
          other.tx((p, t) =>
            p.abortConsumption(t, { ...key, executionNo: null, code: 'SCOPE_REQUIRED', recovery: 'new_run' }),
          ),
          'EXECUTION_INACTIVE',
        );
      });

      it('项目重启取代：非终态行 superseded，已终态行不动；之后断言与写入报 RUN_SUPERSEDED', async () => {
        const { h, tx, begin, plan, record, outcomes, rejects } = await setup();
        await begin();
        await plan();
        await record([item('target', T_G1), item('nomination', FX.n1)]);
        await h.supersede(FX.run);
        const rows = (await outcomes()).items;
        expect(rows.find((row) => row.rowId === FX.n1)).toMatchObject({ status: 'synced' });
        expect(rows.find((row) => row.rowId === T_P1)).toMatchObject({
          status: 'superseded',
          errorCode: 'RUN_SUPERSEDED',
        });
        expect((await tx((p, t) => p.loadRun(t, key)))?.status).toBe('superseded');
        const active = { ...key, executionNo: 1, leaseOwner: 'w1' };
        await rejects(
          tx((p, t) => p.assertExecutionActive(t, active)),
          'RUN_SUPERSEDED',
        );
        await rejects(record([item('target', T_P1)], 2), 'RUN_SUPERSEDED');
        const aborted = tx((p, t) =>
          p.abortConsumption(t, { ...key, executionNo: 1, code: 'ABORTED_BY_ADMIN', recovery: 'terminate' }),
        );
        expect(await aborted).toMatchObject({ status: 'superseded', terminalCode: 'RUN_SUPERSEDED' });
      });

      it('跳过行与健康度目标写入范围不足都不阻塞完成（partial 完成）', async () => {
        const { tx, begin, plan, record } = await setup();
        await begin();
        await plan([
          item('nomination', FX.n3, { status: 'skipped', errorParams: { reason: 'direction_target' } }),
          item('object', FX.o2, { status: 'skipped', errorParams: { reason: 'no_nominations' } }),
          item('org_health', FX.g2, { status: 'skipped', errorParams: { reason: 'not_provided' } }),
        ]);
        await record([
          item('target', T_G1),
          item('nomination', FX.n1),
          item('target', T_P1),
          item('nomination', FX.n2),
          item('object', FX.o1),
          failed('org_health', FX.g1, 'TARGET_OUT_OF_SCOPE'),
        ]);
        const done = await tx((p, t) => p.completeConsumption(t, { ...key, executionNo: 1 }));
        expect(done.counts).toMatchObject({ pending: 0, failed: 1, failedRetry: 0, skipped: 3 });
      });
    });

    describe('SP-06 三档选择器与无 run 读取', () => {
      const asOf = '2026-10-09';
      const viewer = { kind: 'user' as const, userId: FX.viewer };

      it('会议上下文只取会中对象，不在会中落到当前项目（不降级为触发项目）；没有进行中项目取最近结束的', async () => {
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
        const before = await read({ asOf: '2026-08-01' });
        expect(before.get(FX.e1)).toMatchObject({ source: { tier: 2 } });
        const history = await read({ asOf: '2025-12-31' });
        expect(history.get(FX.e1)).toMatchObject({ source: null, values: { potential: { status: 'unavailable' } } });
        await h.denyViewer(FX.viewer, { fieldCodes: ['potential'], employeeIds: [FX.e2] });
        const denied = await read({});
        expect(denied.get(FX.e1)?.values.potential).toEqual({ status: 'forbidden', value: null });
        expect(denied.get(FX.e2)).toMatchObject({ source: null, values: { potential: { status: 'forbidden' } } });
      });

      it('继任读取区分 module_absent 与零提名；组织读取只取 successor 方向的组织提名；绿化率分母为放置人数', async () => {
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
            context: { asOf },
            viewer,
          }),
        );
        expect(current.map((entry) => [entry.status, entry.nominations.map((n) => n.nominationId)])).toEqual([
          ['value', []],
          ['value', [FX.n1]],
        ]);
        const rates = await tx((p, t) =>
          p.greenRate(t, { tenantId: FX.tenant, orgIds: [FX.g1, FX.g2], context: { asOf }, viewer }),
        );
        expect(rates.get(FX.g1)).toMatchObject({ green: 1, placed: 2, rate: 0.5, source: { matrixId: FX.matrix } });
        expect(rates.get(FX.g2)).toMatchObject({ placed: 0, rate: null, source: null });
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

      it('计算回写：手动值保留（优先于版本）；版本不符冲突且不改；命令同键同内容幂等、异内容冲突', async () => {
        const { tx, rejects } = await setup();
        const credential = {
          kind: 'compute' as const,
          principalUserId: FX.principal,
          calcRunId: FX.run,
          commandId: 'c1',
        };
        const write = (rows: ReturnType<typeof row>[], commandId = 'c1') =>
          tx((p, t) =>
            p.recordOrgHealth(t, { tenantId: FX.tenant, context, credential: { ...credential, commandId }, rows }),
          );
        const receipt = await write([row(FX.g2, 1), row(FX.g1, 0)]);
        expect(receipt.items.map((i) => [i.orgId, i.outcome])).toEqual([
          [FX.g1, 'MANUAL_KEPT'],
          [FX.g2, 'REVISION_CONFLICT'],
        ]);
        expect(receipt.items[1]).toMatchObject({ currentRevision: 0, currentLevelId: null });
        expect(await write([row(FX.g2, 1), row(FX.g1, 0)])).toEqual(receipt);
        await rejects(write([row(FX.g2, 0)]), 'IDEMPOTENCY_CONFLICT');
        const ok = await write([row(FX.g2, 0)], 'c2');
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

      it('逐组织授权：缺按钮 FORBIDDEN、组织不在范围 OUT_OF_SCOPE、项目已结束 PROJECT_ENDED', async () => {
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
        expect((await assign(FX.viewer, 'x1')).items.map((i) => i.outcome)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
        expect((await assign(FX.actor, 'x2')).items.map((i) => i.outcome)).toEqual(['written', 'OUT_OF_SCOPE']);
        await h.endProject(FX.project);
        expect((await assign(FX.writer, 'x3')).items.map((i) => i.outcome)).toEqual(['PROJECT_ENDED', 'PROJECT_ENDED']);
      });
    });
  });
}

/** 替身工厂：直接以替身作控制面（transaction 失败整体回滚）。 */
export const inMemorySyncPortFactory: SyncPortFactory = async (fixture) => {
  const port = createInMemoryTalentReviewSyncPort(fixture);
  return {
    port,
    transaction: (work) => port.transaction(work),
    supersede: async (runId) => port.supersede(runId),
    revoke: async (change) => port.revoke(change),
    denyViewer: async (userId, denied) => port.denyViewer(userId, denied),
    denyHealthWrite: async (userId, access) => port.denyHealthWrite(userId, access),
    endProject: async (projectId) => port.endProject(projectId),
    advance: async (seconds) => port.advance(seconds),
  };
};

runSyncPortContractSuite('内存替身', inMemorySyncPortFactory);
