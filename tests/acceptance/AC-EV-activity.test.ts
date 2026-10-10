/**
 * R3-T02 PR-B B5：评定活动主体与环节（`TEvaluation.EvaluationActivity` + 环节 `ev_chains`，设计 §3.2、§5.1、§5.3；拆分方案第 4 节
 * B5 行；规格 24 EV-R9、R12～R14、R17；DEC-370② Q-T02-09、DEC-372②）。真实授权器：
 * - 活动：所属组织必填手选且须在操作人范围内（DEC-082 / DEC-324②），列表 / 详情按所属组织 ∪ 所属人裁剪（分页前），无向下公开；
 * - 整份提交：环节嵌套，整体成功或失败；类型 / 周期 / 类别 / 级别 / 评价表 / 负责人的引用按各自的查看权、范围、启用校验；
 * - 跨级限制 max_level_jump 必填 1～5、缺省 1（DEC-372②）；
 * - 适用范围重复拦截：与进行中的活动组织范围、申请类别都有交集 → 409 ACTIVITY_SCOPE_DUPLICATE，范围外或名称字段看不到时不带名称；
 * - 环节规则：apply 与 result 必有、各类 ≤ 1、日期在活动起止内、defense → result 只能手动、apply 审批流程必填；
 * - 活动类型 / 周期 / 评价表被活动引用时拒删（周期 / 类型另拒停用）。
 * 编辑锁（AC-EV-05）见 AC-EV-05-edit-lock，并发见 AC-EV-activity-recheck-pg。取证待定的口径（编码 / 必填项 / 删除条件等）
 * 按保守默认实现，见 #217 之后新开的需取证 issue；测试计数按 test case 计。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok } from './AC-EV-support.js';
import {
  ACTIVITIES,
  type ActivityOperator,
  type ActivityOperatorOptions,
  activityOperator,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
  type ActivityFixtures,
  activityFixtures,
  type Dict,
  sendableChain,
} from './AC-EV-activity-support.js';

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

interface Page {
  readonly hasDataPermission: boolean;
  readonly items: ActivityView[];
}

describe('AC-EV-activity 评定活动主体与环节', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  let form1: Dict;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
    form1 = f.form1;
  });
  const chains = (formId?: string) => f.chains(formId);
  const body = (extra: Record<string, unknown> = {}) => f.body(extra);
  const manager = (options: ActivityOperatorOptions = {}) =>
    activityOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA], ...options });
  const post = (op: ActivityOperator, data: Record<string, unknown>, extra = {}) =>
    op.request('POST', ACTIVITIES, { ifMatch: 0, body: data, ...extra });
  const created = (op: ActivityOperator, data: Record<string, unknown> = body()) =>
    post(op, data).then((r) => ok<ActivityView>(r, 201));
  const patch = (op: ActivityOperator, activity: ActivityView, data: Record<string, unknown>, extra = {}) =>
    op.request('PATCH', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, body: data, ...extra });
  const read = (op: ActivityOperator, id: string) => op.request('GET', `${ACTIVITIES}/${id}`);
  const sendable = sendableChain;
  const expectError = async (response: Response, status: number, reason?: string) => {
    expect(response.status, await response.clone().text()).toBe(status);
    if (reason) expect((await errorOf(response)).reason).toBe(reason);
  };
  describe('CRUD 与整份提交', () => {
    it('新建 / 详情 / 修改 / 删除：状态 draft、报名数 0、环节按提交顺序并带稳定 ID、没有 status 以外的系统字段输入', async () => {
      const op = await manager();
      const activity = await created(op);
      expect(activity).toMatchObject({
        revision: 1,
        status: 'draft',
        applyCount: 0,
        ownerOrgId: w.orgA,
        ownerId: op.userId,
        createdBy: op.userId,
        maxLevelJump: 1,
        managerEmployeeId: f.mgrA.id,
        orgRange: [w.orgA],
        categoryIds: [f.cat1.id],
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(activity.chains.map((chain) => chain.type)).toEqual(['apply', 'material', 'defense', 'result']);
      expect(activity.chains.every((chain) => chain.id)).toBe(true);
      expect(activity.chains[3]).toMatchObject({ transferMode: 'manual', formId: null, approvalProcessCode: null });
      expect(await ok<ActivityView>(await read(op, activity.id))).toEqual(activity);
      const renamed = await ok<ActivityView>(await patch(op, activity, { name: `改名${suffix()}`, year: 2027 }));
      expect(renamed).toMatchObject({ revision: 2, year: 2027, status: 'draft' });
      expect(renamed.chains).toEqual(activity.chains);
      const removed = await op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: renamed.revision });
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect((await read(op, activity.id)).status).toBe(404);
    });

    it('整份修改：环节按类型对应更新，保留稳定 ID；未传 chains 不动环节；重排顺序按提交顺序', async () => {
      const op = await manager();
      const activity = await created(op);
      const next = activity.chains.map(sendable);
      const edited = await ok<ActivityView>(
        await patch(op, activity, { chains: next.map((c) => (c.type === 'defense' ? { ...c, name: '终审答辩' } : c)) }),
      );
      expect(edited.chains.map((c) => c.id)).toEqual(activity.chains.map((c) => c.id));
      expect(edited.chains[2]!.name).toBe('终审答辩');
      const same = await ok<ActivityView>(await patch(op, edited, { name: `只改名${suffix()}` }));
      expect(same.chains).toEqual(edited.chains);
      const swapped = await ok<ActivityView>(await patch(op, same, { chains: [next[0], next[2], next[1], next[3]] }));
      expect(swapped.chains.map((c) => c.type)).toEqual(['apply', 'defense', 'material', 'result']);
      // 环节身份按类型保持：重排只改顺序，不换 ID（C2 的指标明细按环节 ID 引用）
      expect(new Set(swapped.chains.map((c) => c.id))).toEqual(new Set(activity.chains.map((c) => c.id)));
    });

    it('活动编码租户内唯一（409 ACTIVITY_CODE_EXISTS）；编码、名称为空或过长 400；新建的 status / applyCount / 所属人等系统字段与未知键 400', async () => {
      const op = await manager();
      const first = await created(op);
      await expectError(await post(op, body({ code: first.code })), 409, 'ACTIVITY_CODE_EXISTS');
      for (const data of [
        { code: '' },
        { code: 'X'.repeat(51) },
        { name: '' },
        { name: '名'.repeat(101) },
        { status: 'published' },
        { applyCount: 3 },
        { ownerId: randomUUID() },
        { unknownKey: 1 },
      ]) {
        await expectError(await post(op, body(data)), 400);
      }
      await expectError(await patch(op, first, { status: 'published' }), 400);
      await expectError(await patch(op, first, { applyCount: 9 }), 400);
    });

    it('日期与年度：开始晚于结束 400；不是日期 400；年度越界 400', async () => {
      const op = await manager();
      await expectError(
        await post(op, body({ startDate: '2026-12-31', endDate: '2026-01-01' })),
        400,
        'ACTIVITY_DATE_RANGE_INVALID',
      );
      for (const data of [{ startDate: '2026-02-30' }, { endDate: '明天' }, { year: 1999 }, { year: 2101 }]) {
        await expectError(await post(op, body(data)), 400);
      }
    });

    it('整份回滚：环节引用的评价表不存在 → 404，活动没有落库；修改时同样整体失败，原活动不变', async () => {
      const op = await manager();
      const data = body();
      await expectError(await post(op, body({ ...data, chains: chains(randomUUID()) })), 404);
      const page = await ok<Page>(await op.request('GET', ACTIVITIES));
      expect(page.items.find((item) => item.code === data.code)).toBeUndefined();
      const activity = await created(op);
      await expectError(await patch(op, activity, { name: '不应落库', chains: chains(randomUUID()) }), 404);
      expect(await w.adminRead(activity.id)).toMatchObject({ revision: 1, name: activity.name });
    });
  });

  describe('跨级限制 max_level_jump（DEC-372②）', () => {
    it('新建未传取 1；1～5 的整数可保存', async () => {
      const op = await manager();
      expect((await created(op, body())).maxLevelJump).toBe(1);
      for (const value of [1, 3, 5]) {
        expect((await created(op, body({ maxLevelJump: value }))).maxLevelJump).toBe(value);
      }
    });

    it('显式空值 / 0 / 6 / 小数 / 字符串 → 400，不当作不限也不静默取缺省', async () => {
      const op = await manager();
      for (const value of [null, 0, 6, -1, 1.5, '3']) {
        await expectError(await post(op, body({ maxLevelJump: value })), 400);
      }
      const activity = await created(op, body({ maxLevelJump: 2 }));
      for (const value of [null, 0, 6]) {
        await expectError(await patch(op, activity, { maxLevelJump: value }), 400);
      }
      expect(await w.adminRead(activity.id)).toMatchObject({ revision: 1, maxLevelJump: 2 });
    });
  });

  describe('环节规则（EV-R12 / R13，DEC-370② Q-T02-09）', () => {
    const apply = () => chains()[0]!;
    const material = () => chains()[1]!;
    const defense = () => chains()[2]!;
    const result = () => chains()[3]!;
    const cases: readonly [string, Record<string, unknown>[], string][] = [
      ['缺少资格申报环节', [material(), defense(), result()], 'ACTIVITY_CHAIN_APPLY_REQUIRED'],
      ['缺少结果发布环节', [apply(), material(), defense()], 'ACTIVITY_CHAIN_RESULT_REQUIRED'],
      [
        '同一类型出现两次',
        [apply(), material(), { ...material(), name: '再来一次' }, result()],
        'ACTIVITY_CHAIN_TYPE_DUPLICATE',
      ],
      ['资格申报不在首位', [material(), apply(), result()], 'ACTIVITY_CHAIN_ORDER_INVALID'],
      ['结果发布不在末位', [apply(), result(), defense()], 'ACTIVITY_CHAIN_ORDER_INVALID'],
      ['环节日期早于活动开始', [{ ...apply(), startDate: '2025-12-31' }, result()], 'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE'],
      ['环节日期晚于活动结束', [apply(), { ...result(), endDate: '2027-01-01' }], 'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE'],
      [
        '环节开始晚于结束',
        [{ ...apply(), startDate: '2026-03-31', endDate: '2026-01-10' }, result()],
        'ACTIVITY_CHAIN_DATE_INVALID',
      ],
      [
        '答辩评审后直接结果发布只能手动转入',
        [apply(), { ...defense(), transferMode: 'auto' }, result()],
        'ACTIVITY_CHAIN_DEFENSE_TRANSFER_MANUAL',
      ],
      ['资格申报没有审批流程', [{ ...apply(), approvalProcessCode: undefined }, result()], 'APPROVAL_PROCESS_REQUIRED'],
      ['资格申报审批流程为空串', [{ ...apply(), approvalProcessCode: '' }, result()], 'APPROVAL_PROCESS_REQUIRED'],
      ['资格申报审批流程为 null', [{ ...apply(), approvalProcessCode: null }, result()], 'APPROVAL_PROCESS_REQUIRED'],
      ['结果发布带评价表', [apply(), { ...result(), formId: form1.id }], 'ACTIVITY_CHAIN_FIELD_NOT_ALLOWED'],
      [
        '非资格申报环节设强控截止',
        [apply(), { ...material(), hardDeadline: true }, result()],
        'ACTIVITY_CHAIN_FIELD_NOT_ALLOWED',
      ],
    ];
    it.each(cases)('%s → 400 %#', async (label, list, reason) => {
      const op = await manager();
      const response = await post(op, body({ chains: list }));
      expect(response.status, `${label}: ${await response.clone().text()}`).toBe(400);
      expect((await errorOf(response)).reason, label).toBe(reason);
    });

    it('最小合法环节：只有资格申报与结果发布；材料 / 答辩可选；答辩之后不是结果发布时可以自动转入', async () => {
      const op = await manager();
      const minimal = await created(op, body({ chains: [apply(), result()] }));
      expect(minimal.chains.map((c) => c.type)).toEqual(['apply', 'result']);
      const loose = await created(
        op,
        body({ chains: [apply(), { ...defense(), transferMode: 'auto' }, material(), result()] }),
      );
      expect(loose.chains.map((c) => c.type)).toEqual(['apply', 'defense', 'material', 'result']);
    });

    it('修改时清空资格申报审批流程 → 400（不是 409），原环节不变', async () => {
      const op = await manager();
      const activity = await created(op);
      const cleared = activity.chains.map((chain) =>
        chain.type === 'apply' ? { ...sendable(chain), approvalProcessCode: null } : sendable(chain),
      );
      await expectError(await patch(op, activity, { chains: cleared }), 400, 'APPROVAL_PROCESS_REQUIRED');
      expect(await w.adminRead(activity.id)).toEqual(activity);
    });
  });
});
