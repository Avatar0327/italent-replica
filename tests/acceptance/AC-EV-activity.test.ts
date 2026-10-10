/**
 * R3-T02 PR-B B5：评定活动主体与环节（`TEvaluation.EvaluationActivity` + 环节 `ev_chains`，设计 §3.2、§5.1、§5.3；拆分方案第 4 节
 * B5 行；规格 24 EV-R9、R12～R14、R17 与 Q-M0-174 补充；DEC-370② Q-T02-09、DEC-372②、DEC-412）。真实授权器：
 * - 活动没有编码字段；必填：名称、类型、所属组织、年度、周期、负责人、评定生效日期、申请人、组织范围、类别 / 级别范围、跨级数（默认 1）；
 *   非必填：起止日期、通知范围、通知模板；申请人多选（本人 / 非本人）；组织范围最多 100 个，每个带“包含下级”（默认勾）；
 * - 所属组织必填手选且须在操作人范围内（DEC-082 / DEC-324②），列表 / 详情按所属组织 ∪ 所属人裁剪（分页前），无向下公开；
 * - 整份提交：环节嵌套，整体成功或失败；
 * - 环节：资格申报在首、结果发布在末且各 1 个；材料举证、答辩评审各最多 3 个，先后不限；评价表只在答辩评审上且必填；转入方式缺省
 *   资格申报 / 材料举证自动，答辩评审只能手动；apply 审批流程必填；
 * - 删除只有草稿；已完成的活动不能修改；
 * 编辑锁（AC-EV-05）见 AC-EV-05-edit-lock，引用与权限见 AC-EV-activity-refs，适用范围重复见 AC-EV-activity-scope-dup，
 * 并发见 AC-EV-activity-recheck-pg。测试计数按 test case 计。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok } from './AC-EV-support.js';
import {
  ACTIVITIES,
  type ActivityFixtures,
  activityFixtures,
  type ActivityOperator,
  type ActivityOperatorOptions,
  activityOperator,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
  sendableChain,
  sendableChainWithId,
} from './AC-EV-activity-support.js';

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

describe('AC-EV-activity 评定活动主体与环节', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
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
    it('新建 / 详情 / 修改 / 删除：状态 draft、报名数 0、环节按提交顺序并带稳定 ID、没有活动编码字段', async () => {
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
        applicants: ['self'],
        orgRange: [{ orgId: w.orgA, includeDescendants: false }],
        categoryIds: [f.cat1.id],
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        effectiveDate: '2027-01-01',
      });
      expect(Object.keys(activity)).not.toContain('code');
      expect(activity.chains.map((chain) => chain.type)).toEqual(['apply', 'material', 'defense', 'result']);
      expect(activity.chains.every((chain) => chain.id)).toBe(true);
      expect(activity.chains[3]).toMatchObject({ transferMode: 'manual', formId: null, approvalProcessCode: null });
      expect(activity.chains[1]).toMatchObject({ transferMode: 'auto', formId: null });
      expect(activity.chains[2]).toMatchObject({ transferMode: 'manual', formId: f.form1.id });
      expect(await ok<ActivityView>(await read(op, activity.id))).toEqual(activity);
      const renamed = await ok<ActivityView>(await patch(op, activity, { name: `改名${suffix()}`, year: 2027 }));
      expect(renamed).toMatchObject({ revision: 2, year: 2027, status: 'draft' });
      expect(renamed.chains).toEqual(activity.chains);
      const removed = await op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: renamed.revision });
      expect(removed.status, await removed.clone().text()).toBe(200);
      expect((await read(op, activity.id)).status).toBe(404);
    });

    it('整份修改：环节保留稳定 ID；未传 chains 不动环节；材料与答辩顺序不限，重排只改顺序不换 ID', async () => {
      const op = await manager();
      const activity = await created(op);
      const next = activity.chains.map((chain) => sendable(chain));
      const edited = await ok<ActivityView>(
        await patch(op, activity, { chains: next.map((c) => (c.type === 'defense' ? { ...c, name: '终审答辩' } : c)) }),
      );
      expect(edited.chains.map((c) => c.id)).toEqual(activity.chains.map((c) => c.id));
      expect(edited.chains[2]!.name).toBe('终审答辩');
      const same = await ok<ActivityView>(await patch(op, edited, { name: `只改名${suffix()}` }));
      expect(same.chains).toEqual(edited.chains);
      const swapped = await ok<ActivityView>(await patch(op, same, { chains: [next[0], next[2], next[1], next[3]] }));
      expect(swapped.chains.map((c) => c.type)).toEqual(['apply', 'defense', 'material', 'result']);
      expect(new Set(swapped.chains.map((c) => c.id))).toEqual(new Set(activity.chains.map((c) => c.id)));
    });

    it('没有活动编码：带 code 键 400；系统字段（status / applyCount / 所属人）与未知键 400；名称为空或过长 400', async () => {
      const op = await manager();
      const first = await created(op);
      for (const data of [
        { code: 'EV1' },
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
      await expectError(await patch(op, first, { code: 'EV2' }), 400);
    });

    it('整份回滚：答辩评审引用的评价表不存在 → 404，活动没有落库；修改时同样整体失败，原活动不变', async () => {
      const op = await manager();
      const data = body();
      await expectError(await post(op, body({ ...data, chains: chains(randomUUID()) })), 404);
      const page = await ok<{ items: ActivityView[] }>(await op.request('GET', `${ACTIVITIES}?pageSize=200`));
      expect(page.items.find((item) => item.name === data.name)).toBeUndefined();
      const activity = await created(op);
      await expectError(await patch(op, activity, { name: '不应落库', chains: chains(randomUUID()) }), 404);
      expect(await w.adminRead(activity.id)).toMatchObject({ revision: 1, name: activity.name });
    });
  });

  describe('必填与非必填（Q-M0-174 / DEC-412）', () => {
    const REQUIRED = [
      'name',
      'typeId',
      'ownerOrgId',
      'year',
      'cycleId',
      'managerEmployeeId',
      'effectiveDate',
      'applicants',
      'orgRange',
      'categoryIds',
      'levelIds',
      'chains',
    ] as const;
    it.each(REQUIRED)('缺少必填项 %s → 400', async (key) => {
      const op = await manager();
      const { [key]: _omitted, ...rest } = body();
      await expectError(await post(op, rest), 400);
    });

    it('非必填：起止日期、通知范围、通知模板可以不填；起止日期不填时环节日期不受活动日期约束；跨级数不传取默认 1', async () => {
      const op = await manager();
      const { startDate: _s, endDate: _e, noticeOrgRange: _n, ...rest } = body();
      const activity = await created(op, rest);
      expect(activity).toMatchObject({ startDate: null, endDate: null, noticeOrgRange: [], maxLevelJump: 1 });
      const dated = await ok<ActivityView>(
        await patch(op, activity, { startDate: '2026-01-01', endDate: '2026-12-31' }),
      );
      expect(dated).toMatchObject({ startDate: '2026-01-01', endDate: '2026-12-31' });
    });

    it('类别 / 级别范围不能为空（范围总落到具体级别）；组织范围不能为空且最多 100 个；申请人至少一项、取值合法、不重复', async () => {
      const op = await manager();
      for (const data of [
        { categoryIds: [] },
        { levelIds: [] },
        { orgRange: [] },
        { orgRange: Array.from({ length: 101 }, () => ({ orgId: randomUUID(), includeDescendants: true })) },
        { applicants: [] },
        { applicants: ['everyone'] },
        { applicants: ['self', 'self'] },
        { managerEmployeeId: null },
        { effectiveDate: null },
      ]) {
        await expectError(await post(op, body(data)), 400);
      }
      const activity = await created(op, body({ applicants: ['self', 'others'] }));
      expect([...activity.applicants].sort()).toEqual(['others', 'self']);
      for (const data of [{ categoryIds: [] }, { levelIds: [] }, { orgRange: [] }, { applicants: [] }]) {
        await expectError(await patch(op, activity, data), 400);
      }
    });

    it('组织范围条目：缺省“包含下级”勾上；同一组织重复 400', async () => {
      const op = await manager();
      const activity = await created(op, body({ orgRange: [{ orgId: w.orgA }] }));
      expect(activity.orgRange).toEqual([{ orgId: w.orgA, includeDescendants: true }]);
      await expectError(
        await post(op, body({ orgRange: [{ orgId: w.orgA }, { orgId: w.orgA, includeDescendants: false }] })),
        400,
        'ACTIVITY_ORG_RANGE_DUPLICATE',
      );
    });
  });

  describe('日期与跨级限制（DEC-372②）', () => {
    it('开始晚于结束 400；不是日期 400；年度越界 400', async () => {
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

    it('maxLevelJump 只读：新建时省略字段由系统初始化为 1（DEC-410②），不授权选其他值；传非默认值 403', async () => {
      const op = await manager({ readonly: ['maxLevelJump'] });
      expect((await created(op, body())).maxLevelJump).toBe(1);
      await expectError(await post(op, body({ maxLevelJump: 3 })), 403);
    });
  });

  describe('环节规则（EV-R12 / R13，Q-M0-174，DEC-370② Q-T02-09，DEC-412）', () => {
    const apply = () => chains()[0]!;
    const material = () => chains()[1]!;
    const defense = () => chains()[2]!;
    const result = () => chains()[3]!;
    const cases: readonly [string, () => Record<string, unknown>[], string][] = [
      ['缺少资格申报环节', () => [material(), defense(), result()], 'ACTIVITY_CHAIN_APPLY_REQUIRED'],
      ['缺少结果发布环节', () => [apply(), material(), defense()], 'ACTIVITY_CHAIN_RESULT_REQUIRED'],
      ['资格申报出现两次', () => [apply(), apply(), result()], 'ACTIVITY_CHAIN_TYPE_DUPLICATE'],
      ['结果发布出现两次', () => [apply(), result(), result()], 'ACTIVITY_CHAIN_TYPE_DUPLICATE'],
      [
        '材料举证 4 个',
        () => [apply(), ...[1, 2, 3, 4].map((n) => ({ ...material(), name: `材料${n}` })), result()],
        'ACTIVITY_CHAIN_COUNT_EXCEEDED',
      ],
      [
        '答辩评审 4 个',
        () => [apply(), ...[1, 2, 3, 4].map((n) => ({ ...defense(), name: `答辩${n}` })), result()],
        'ACTIVITY_CHAIN_COUNT_EXCEEDED',
      ],
      ['资格申报不在首位', () => [material(), apply(), result()], 'ACTIVITY_CHAIN_ORDER_INVALID'],
      ['结果发布不在末位', () => [apply(), result(), defense()], 'ACTIVITY_CHAIN_ORDER_INVALID'],
      [
        '环节日期早于活动开始',
        () => [{ ...apply(), startDate: '2025-12-31' }, result()],
        'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE',
      ],
      [
        '环节日期晚于活动结束',
        () => [apply(), { ...result(), endDate: '2027-01-01' }],
        'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE',
      ],
      [
        '环节开始晚于结束',
        () => [{ ...apply(), startDate: '2026-03-31', endDate: '2026-01-10' }, result()],
        'ACTIVITY_CHAIN_DATE_INVALID',
      ],
      [
        '答辩评审只有手动转入',
        () => [apply(), { ...defense(), transferMode: 'auto' }, result()],
        'ACTIVITY_CHAIN_DEFENSE_TRANSFER_MANUAL',
      ],
      [
        '答辩评审必填评价表',
        () => [apply(), { ...defense(), formId: undefined }, result()],
        'ACTIVITY_CHAIN_FORM_REQUIRED',
      ],
      [
        '答辩评审评价表为 null',
        () => [apply(), { ...defense(), formId: null }, result()],
        'ACTIVITY_CHAIN_FORM_REQUIRED',
      ],
      [
        '材料举证没有评价表',
        () => [apply(), { ...material(), formId: f.form1.id }, result()],
        'ACTIVITY_CHAIN_FIELD_NOT_ALLOWED',
      ],
      [
        '资格申报没有审批流程',
        () => [{ ...apply(), approvalProcessCode: undefined }, result()],
        'APPROVAL_PROCESS_REQUIRED',
      ],
      [
        '资格申报审批流程为空串',
        () => [{ ...apply(), approvalProcessCode: '' }, result()],
        'APPROVAL_PROCESS_REQUIRED',
      ],
      [
        '资格申报审批流程为 null',
        () => [{ ...apply(), approvalProcessCode: null }, result()],
        'APPROVAL_PROCESS_REQUIRED',
      ],
      [
        '非资格申报环节设强控截止',
        () => [apply(), { ...material(), hardDeadline: true }, result()],
        'ACTIVITY_CHAIN_FIELD_NOT_ALLOWED',
      ],
    ];
    it.each(cases)('%s → 400 %#', async (label, list, reason) => {
      const op = await manager();
      const response = await post(op, body({ chains: list() }));
      expect(response.status, `${label}: ${await response.clone().text()}`).toBe(400);
      expect((await errorOf(response)).reason, label).toBe(reason);
    });

    it('最小合法环节：只有资格申报与结果发布；材料 / 答辩各最多 3 个、先后不限（材料可以在答辩后面）', async () => {
      const op = await manager();
      const minimal = await created(op, body({ chains: [apply(), result()] }));
      expect(minimal.chains.map((c) => c.type)).toEqual(['apply', 'result']);
      const full = await created(
        op,
        body({
          chains: [
            apply(),
            { ...defense(), name: '答辩一' },
            { ...material(), name: '材料一' },
            { ...defense(), name: '答辩二' },
            { ...material(), name: '材料二' },
            { ...material(), name: '材料三' },
            { ...defense(), name: '答辩三' },
            result(),
          ],
        }),
      );
      expect(full.chains.map((c) => c.type)).toEqual([
        'apply',
        'defense',
        'material',
        'defense',
        'material',
        'material',
        'defense',
        'result',
      ]);
      expect(new Set(full.chains.map((c) => c.id)).size).toBe(8);
    });

    it('转入方式缺省：资格申报 / 材料举证自动转入，答辩评审与结果发布手动', async () => {
      const op = await manager();
      const list = chains().map(({ transferMode: _mode, ...chain }) => chain);
      const activity = await created(op, body({ chains: list }));
      expect(activity.chains.map((chain) => chain.transferMode)).toEqual(['auto', 'auto', 'manual', 'manual']);
    });

    it('修改多个同类环节：带 id 的按 id 对应保留稳定 ID，没带 id 的按类型顺序对应；新增的材料环节得到新 ID', async () => {
      const op = await manager();
      const activity = await created(
        op,
        body({
          chains: [chains()[0], { ...chains()[1], name: '材料一' }, { ...chains()[1], name: '材料二' }, chains()[3]],
        }),
      );
      const [apply0, m1, m2, result0] = activity.chains;
      const swapped = await ok<ActivityView>(
        await patch(op, activity, {
          chains: [apply0, m2, m1, result0].map((chain) => sendableChainWithId(chain!)),
        }),
      );
      expect(swapped.chains.map((c) => c.id)).toEqual([apply0!.id, m2!.id, m1!.id, result0!.id]);
      expect(swapped.chains.map((c) => c.name)).toEqual(['资格申报', '材料二', '材料一', '结果发布']);
      const grown = await ok<ActivityView>(
        await patch(op, swapped, {
          chains: [
            ...swapped.chains.slice(0, 3).map((chain) => sendableChainWithId(chain)),
            { ...chains()[1], name: '材料三' },
            sendableChainWithId(swapped.chains[3]!),
          ],
        }),
      );
      expect(grown.chains).toHaveLength(5);
      expect(grown.chains.slice(0, 3).map((c) => c.id)).toEqual(swapped.chains.slice(0, 3).map((c) => c.id));
      expect(grown.chains[3]!.id).not.toBe(m1!.id);
      await expectError(
        await patch(op, grown, { chains: [{ ...sendableChain(grown.chains[0]!), id: randomUUID() }, chains()[3]] }),
        400,
        'ACTIVITY_CHAIN_ID_UNKNOWN',
      );
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

  describe('删除与已完成活动（Q-M0-174 第 7、8 点）', () => {
    it('只有草稿能删；进行中提示“此活动进行中，无法删除”，已完成提示“此活动已完成，无法删除”，数据不变', async () => {
      const op = await manager();
      const remove = (activity: ActivityView) =>
        op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision });
      const texts = { published: '此活动进行中，无法删除', completed: '此活动已完成，无法删除' } as const;
      for (const status of ['published', 'completed'] as const) {
        const activity = await w.adminActivity(body());
        await w.setStatus(activity.id, status);
        const current = await w.adminRead(activity.id);
        const response = await remove(current);
        await expectError(response, 409, 'ACTIVITY_NOT_DRAFT');
        expect(((await response.json()) as { error: { message: string } }).error.message).toBe(texts[status]);
        expect(await w.adminRead(activity.id)).toEqual(current);
      }
    });

    it('已完成的活动不能修改：409 ACTIVITY_COMPLETED，提示“此活动已完成，无法修改”；进行中可以按规则修改', async () => {
      const op = await manager();
      const done = await w.adminActivity(body());
      await w.setStatus(done.id, 'completed');
      const current = await w.adminRead(done.id);
      const response = await patch(op, current, { name: `不应改${suffix()}` });
      await expectError(response, 409, 'ACTIVITY_COMPLETED');
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe('此活动已完成，无法修改');
      expect(await w.adminRead(done.id)).toEqual(current);
      const live = await w.adminActivity(body());
      await w.setStatus(live.id, 'published');
      const renamed = await patch(op, await w.adminRead(live.id), { name: `进行中改名${suffix()}` });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
    });
  });

  describe('错误提示不泄露隐藏的环节名称（#226 第 1 轮 P2-1）', () => {
    const TYPES = ['apply', 'material', 'defense', 'result'] as const;
    /** 只有 `target` 环节早于 3 月 1 日开始，其余都在 3 月之后：把活动开始日期改到 3 月 1 日只会让这一个环节落到活动日期之外。 */
    const chainsWithEarly = (target: (typeof TYPES)[number]) =>
      chains().map((chain) => ({
        ...chain,
        name: `不可见环节-${chain.type}`,
        ...(chain.type === target
          ? { startDate: '2026-01-15' }
          : chain.type === 'apply'
            ? { startDate: '2026-03-05' }
            : {}),
      }));

    it.each(TYPES)(
      '隐藏 chains 字段的人缩短活动日期让%s环节落到范围外：400 带机器错误码，提示不含环节名称',
      async (type) => {
        const activity = await w.adminActivity(body({ chains: chainsWithEarly(type) }));
        const blind = await manager({ hidden: ['chains'] });
        const response = await patch(blind, activity, { startDate: '2026-03-01' });
        await expectError(response, 400, 'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE');
        expect(await response.clone().text()).not.toContain('不可见环节');
        expect(await w.adminRead(activity.id)).toMatchObject({ revision: 1, startDate: '2026-01-01' });
      },
    );

    it('对照：对 chains 字段有查看权的人拿到带环节名称的提示', async () => {
      const activity = await w.adminActivity(body({ chains: chainsWithEarly('defense') }));
      const sighted = await manager();
      const response = await patch(sighted, activity, { startDate: '2026-03-01' });
      await expectError(response, 400, 'ACTIVITY_CHAIN_DATE_OUT_OF_RANGE');
      expect(await response.clone().text()).toContain('不可见环节-defense环节日期须在活动起止日期之内');
    });
  });
});
