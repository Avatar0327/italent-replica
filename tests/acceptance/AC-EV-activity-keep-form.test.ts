/**
 * R3-T02 B5 评定活动保存：环节评价表“保留旧引用”只豁免同一稳定环节（F-106，DEC-455③；#226 B5，F-087 排查 A 类）。
 * 旧实现按整份活动里的评价表 ID 集合判“原有”：不可见 / 停用的表只要活动里别的环节已经引用着，挂到新环节或改绑已有环节也放行。
 * 口径（DEC-455③）：
 * - “同一稳定环节”按环节稳定 ID（`matchChains` 的对应结果）判定，不看提交顺序；只调顺序、同一环节仍引用原表 → 放行；
 * - 已保留的引用之后变为停用 / 不可见：同一环节继续保留，放行；挂到新环节或改绑才按新增引用校验（与直接新建一致）；
 * - 不可见（无评价表查看权）403，停用 400 REFERENCE_DISABLED，范围外与不存在 404；拒绝时同一事务不写任何数据（revision 不变）。
 * 真 PG：设了 TEST_DATABASE_URL 时 `useTestDb` 即真 PostgreSQL，`adminRead` 是另一个请求（独立事务）的回查。
 */
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
  sendableChainWithId,
} from './AC-EV-activity-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const suffix = () => uniqueSuffix();

type ChainBody = Record<string, unknown>;

describe('AC-EV-activity-keep-form 环节评价表保留旧引用只豁免同一环节', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
  });

  const operator = (options: ActivityOperatorOptions = {}) =>
    activityOperator(w, { evOrgs: [w.orgA], personOrgs: [w.orgA], ...options });
  const patch = (op: ActivityOperator, activity: ActivityView, data: Record<string, unknown>) =>
    op.request('PATCH', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, body: data });
  const expectError = async (response: Response, status: number, reason?: string) => {
    expect(response.status, await response.clone().text()).toBe(status);
    if (reason) expect((await errorOf(response)).reason).toBe(reason);
  };

  /** 管理员建一个带两个答辩评审环节的活动：第一个引用 `target`，第二个引用另一张正常的表。 */
  async function seeded(target: { id: string }) {
    const other = await w.form(w.orgA, `另一张评价表${suffix()}`);
    const base = f.chains(target.id);
    const secondDefense = { ...base[2]!, name: '终审答辩', formId: other.id };
    const activity = await w.adminActivity(f.body({ chains: [base[0], base[1], base[2], secondDefense, base[3]] }));
    const defenses = activity.chains.filter((chain) => chain.type === 'defense');
    return { activity, other, first: defenses[0]!, second: defenses[1]! };
  }
  /** 回查（独立请求 / 事务）：活动 revision 与各环节评价表都没变。 */
  async function expectUntouched(before: ActivityView) {
    const after = await w.adminRead(before.id);
    expect(after.revision).toBe(before.revision);
    expect(after.chains.map((chain) => [chain.id, chain.formId])).toEqual(
      before.chains.map((chain) => [chain.id, chain.formId]),
    );
  }
  const withIds = (activity: ActivityView, change: (chain: ChainBody) => ChainBody = (chain) => chain) =>
    activity.chains.map((chain) => change(sendableChainWithId(chain)));
  const addDefense = (chains: ChainBody[], formId: string): ChainBody[] => {
    const newcomer = { type: 'defense', name: '加试答辩', startDate: '2026-06-01', endDate: '2026-08-31', formId };
    return [...chains.slice(0, -1), newcomer, chains[chains.length - 1]!];
  };
  const rebind = (chains: ChainBody[], id: string, formId: string): ChainBody[] =>
    chains.map((chain) => (chain.id === id ? { ...chain, formId } : chain));

  describe('四种拒绝：别的环节已引用着不可见 / 停用的表，也不能挂到新环节或改绑已有环节', () => {
    it('不可见（无评价表查看权）：挂到新环节 403，改绑已有环节 403，都不写入', async () => {
      const { activity, second } = await seeded(f.form1);
      const op = await operator({ noFormObject: true });
      await expectError(await patch(op, activity, { chains: addDefense(withIds(activity), f.form1.id) }), 403);
      await expectUntouched(activity);
      await expectError(await patch(op, activity, { chains: rebind(withIds(activity), second.id, f.form1.id) }), 403);
      await expectUntouched(activity);
    });

    it('停用：挂到新环节 400 REFERENCE_DISABLED，改绑已有环节 400 REFERENCE_DISABLED，都不写入', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, second } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const added = await patch(op, activity, { chains: addDefense(withIds(activity), spare.id) });
      await expectError(added, 400, 'REFERENCE_DISABLED');
      await expectUntouched(activity);
      const rebound = await patch(op, activity, { chains: rebind(withIds(activity), second.id, spare.id) });
      await expectError(rebound, 400, 'REFERENCE_DISABLED');
      await expectUntouched(activity);
    });

    it('范围外的表：挂到新环节 / 改绑已有环节与不存在同一 404（与直接新建一致）', async () => {
      const { activity, second } = await seeded(f.formB);
      const op = await operator();
      await expectError(await patch(op, activity, { chains: addDefense(withIds(activity), f.formB.id) }), 404);
      await expectUntouched(activity);
      await expectError(await patch(op, activity, { chains: rebind(withIds(activity), second.id, f.formB.id) }), 404);
      await expectUntouched(activity);
    });

    it('先把环节改绑走、同一次保存里再让另一个新环节挂回原表：按新环节校验（不因原环节曾引用而豁免）', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, other, first } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const moved = addDefense(rebind(withIds(activity), first.id, other.id), spare.id);
      await expectError(await patch(op, activity, { chains: moved }), 400, 'REFERENCE_DISABLED');
      await expectUntouched(activity);
    });
  });

  describe('不带 ID 的环节：只有“纯无 ID 原样重提”才继承原引用豁免（DEC-455③ 第 4 条，#305 第 1 轮 P2）', () => {
    /** 删除第一个答辩环节（A），其余环节保留 ID，再加入不带 ID 的新答辩环节引用 `formId`。 */
    const deleteThenAdd = (activity: ActivityView, deletedId: string, formId: string) => {
      const kept = withIds(activity).filter((chain) => chain.id !== deletedId);
      return addDefense(kept, formId);
    };
    const stripIds = (chains: ChainBody[]) => chains.map(({ id: _id, ...rest }) => rest);

    it('删除原环节 A、其他环节带 ID、新增无 ID 环节引用不可见的原表 → 403，不写入', async () => {
      const { activity, first } = await seeded(f.form1);
      const op = await operator({ noFormObject: true });
      const chains = deleteThenAdd(activity, first.id, f.form1.id);
      await expectError(await patch(op, activity, { chains }), 403);
      await expectUntouched(activity);
    });

    it('删除原环节 A、其他环节带 ID、新增无 ID 环节引用已停用的原表 → 400 REFERENCE_DISABLED，不写入', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, first } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const chains = deleteThenAdd(activity, first.id, spare.id);
      await expectError(await patch(op, activity, { chains }), 400, 'REFERENCE_DISABLED');
      await expectUntouched(activity);
    });

    it('纯无 ID 模式下改了名称的环节引用不可见的表 → 403；引用停用的表 → 400', async () => {
      const hidden = await seeded(f.form1);
      const rename = (activity: ActivityView, id: string) =>
        stripIds(withIds(activity, (c) => (c.id === id ? { ...c, name: '改名答辩' } : c)));
      const blind = await operator({ noFormObject: true });
      await expectError(await patch(blind, hidden.activity, { chains: rename(hidden.activity, hidden.first.id) }), 403);
      await expectUntouched(hidden.activity);
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const disabled = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const response = await patch(op, disabled.activity, { chains: rename(disabled.activity, disabled.first.id) });
      await expectError(response, 400, 'REFERENCE_DISABLED');
      await expectUntouched(disabled.activity);
    });

    it('纯无 ID 模式下改的是不带评价表的环节名称 → 放行（引用的表未变，不重校）', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, first } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const chains = stripIds(withIds(activity, (c) => (c.type === 'material' ? { ...c, name: '改名举证' } : c)));
      const kept = await ok<ActivityView>(await patch(op, activity, { chains }));
      expect(kept.chains.find((chain) => chain.id === first.id)?.formId).toBe(spare.id);
    });
  });

  describe('放行：同一稳定环节保留原引用', () => {
    it('表后来停用：只改名称 / 只调顺序（按环节 ID 对应）仍放行，各环节评价表不变', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, first, second } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const renamed = await ok<ActivityView>(
        await patch(op, activity, { chains: withIds(activity, (c) => ({ ...c, name: `${String(c.name)}改` })) }),
      );
      expect(renamed.chains.find((chain) => chain.id === first.id)?.formId).toBe(spare.id);
      // 调换两个答辩评审环节的先后：每个环节仍引用自己原来的表
      const chains = withIds(renamed);
      const [i, j] = [first.id, second.id].map((id) => chains.findIndex((chain) => chain.id === id)) as [
        number,
        number,
      ];
      [chains[i], chains[j]] = [chains[j]!, chains[i]!];
      const reordered = await ok<ActivityView>(await patch(op, renamed, { chains }));
      const formOf = (view: ActivityView, id: string) => view.chains.find((chain) => chain.id === id)?.formId;
      expect(formOf(reordered, first.id)).toBe(spare.id);
      expect(formOf(reordered, second.id)).toBe(formOf(activity, second.id));
      expect(reordered.chains.map((chain) => chain.id)).toEqual(chains.map((chain) => chain.id));
      expect(reordered.revision).toBe(renamed.revision + 1);
    });

    it('表对操作人不可见（无评价表查看权）：同一环节原样保留放行，不强制改绑', async () => {
      const { activity, first } = await seeded(f.form1);
      const op = await operator({ noFormObject: true });
      const kept = await ok<ActivityView>(
        await patch(op, activity, { name: `保留${suffix()}`, chains: withIds(activity) }),
      );
      expect(kept.chains.find((chain) => chain.id === first.id)?.formId).toBe(f.form1.id);
      expect(kept.revision).toBe(activity.revision + 1);
    });

    it('不带环节 ID、按同类型顺序对应到原环节的原样重提也算同一环节（对应关系即稳定 ID）', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, first } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const chains = withIds(activity).map(({ id: _id, ...rest }) => rest);
      const kept = await ok<ActivityView>(await patch(op, activity, { chains }));
      expect(kept.chains.find((chain) => chain.id === first.id)?.formId).toBe(spare.id);
    });

    it('改绑到新的可用表放行；同一环节从停用表改绑后，被其他环节再引用同一停用表仍拒绝', async () => {
      const spare = await w.form(w.orgA, `将停用评价表${suffix()}`);
      const { activity, other, first, second } = await seeded(spare);
      await w.forceDisable('ev_forms', spare.id);
      const op = await operator();
      const fresh = await w.form(w.orgA, `新评价表${suffix()}`);
      const moved = await ok<ActivityView>(
        await patch(op, activity, { chains: rebind(withIds(activity), first.id, fresh.id) }),
      );
      expect(moved.chains.find((chain) => chain.id === first.id)?.formId).toBe(fresh.id);
      expect(moved.chains.find((chain) => chain.id === second.id)?.formId).toBe(other.id);
      // 停用表已经没有环节引用它，此后再挂只能当新引用，被拒
      await expectError(await patch(op, moved, { chains: rebind(withIds(moved), second.id, spare.id) }), 400);
      await expectUntouched(moved);
    });
  });
});
