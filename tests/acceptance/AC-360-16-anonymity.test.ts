/**
 * AC-360-16（DEC-149，取代 DEC-065 兜底）：不设最少评价人数阈值、不按人数隐藏分数；「设置评价者」页给出不拦截提示；
 * 活动级开关控制作答页是否显示评价者姓名 / 评价角色。另按“查看人 × 接口 × 字段”矩阵核对 PR-A 范围内的可见性：
 * 查看人 = 评价者（本人链接）/ 其他评价者 / 被评价人 / 360 管理员 / 无该活动授权的管理员 / 非 360 成员；
 * 接口 = 作答页、作答详情、得分（管理员）。核对允许字段的实际值与被裁剪字段的缺席。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();
const HINT = '建议各评价角色至少3人（上级和自评除外），以增加匿名性和准确性';

async function setup(w: World360, activity: Record<string, unknown>) {
  const q = await w.enableQuestionnaire(await w.keyBehavior());
  const created = await w.activity(activity);
  const target = await w.person('被评价人E');
  const object = await w.object(created.id, target.id, [q.id]);
  const peer = await w.person('同事甲');
  const subs = [];
  for (let i = 0; i < 4; i++) subs.push(await w.person(`下级${i}`));
  const peerRelation = await w.appraiser(created.id, object.id, peer.id, 'peer');
  const subRelations = [];
  for (const sub of subs) subRelations.push(await w.appraiser(created.id, object.id, sub.id, 'subordinate'));
  const selfRelation = await w.appraiser(created.id, object.id, target.id, 'self');
  return { q, activity: created, target, object, peer, subs, peerRelation, subRelations, selfRelation };
}

interface LinkView {
  activity: Record<string, unknown>;
  appraiser?: { name: string };
  tasks: { relationId: string; object: { name: string }; role?: { name: string } }[];
}

describe('AC-360-16 匿名：不设人数阈值，只提示', () => {
  it('同事只有 1 名评价者：提示但不拦截；得分照常单列同事组', async () => {
    const w = await world360(testDb().db, 'n16');
    const s = await setup(w, {});
    const list = await w.ok<{ hint: string; roleCounts: Record<string, number>; items: unknown[] }>(
      w.request('GET', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers`),
    );
    expect(list.hint).toBe(HINT);
    expect(list.roleCounts).toEqual({ [w.role('peer')]: 1, [w.role('subordinate')]: 4, [w.role('self')]: 1 });
    await w.transition(s.activity.id, 'enable');
    const answer = async (personId: string, relationId: string, picks: [string, string]) =>
      expect(
        ((await w.answer(await w.token(s.activity.id, personId), relationId, s.q, picks)) as Response).status,
      ).toBe(200);
    await answer(s.peer.id, s.peerRelation.id, ['v5', 'v5']);
    for (const [i, sub] of s.subs.entries()) await answer(sub.id, s.subRelations[i]!.id, ['v4', 'v4']);
    await w.transition(s.activity.id, 'disable');
    const rows = await w.scores(s.activity.id, s.object.id);
    const peer = rows.find((r) => r.level === 'questionnaire' && r.roleId === w.role('peer'))!;
    expect(peer).toEqual({
      questionnaireId: s.q.id,
      level: 'questionnaire',
      itemId: null,
      scope: 'role',
      roleId: w.role('peer'),
      roleName: '同事',
      score: 5,
      raterCount: 1,
    });
    // 得分只有聚合值：没有任何评价者标识
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(Object.keys(peer).sort());
  });
});

describe('作答页匿名开关（活动级，DEC-149）× 查看人', () => {
  it('显示姓名 + 显示角色名称：评价者看到自己的姓名与角色', async () => {
    const w = await world360(testDb().db, 'n16a');
    const s = await setup(w, { showAppraiserName: true, roleDisplay: 'name' });
    await w.transition(s.activity.id, 'enable');
    const view = await w.ok<LinkView>(w.link(await w.token(s.activity.id, s.peer.id))('GET', ''));
    expect(view.appraiser).toEqual({ name: '同事甲', avatar: null });
    expect(view.tasks).toEqual([
      {
        relationId: s.peerRelation.id,
        object: { name: '被评价人E', avatar: null },
        role: { name: '同事' },
        questionnaires: [expect.objectContaining({ id: s.q.id, status: 'pending' })],
      },
    ]);
  });

  it('不显示姓名 + 不显示角色：两个键都缺席', async () => {
    const w = await world360(testDb().db, 'n16b');
    const s = await setup(w, { showAppraiserName: false, roleDisplay: 'hidden' });
    await w.transition(s.activity.id, 'enable');
    const view = await w.ok<LinkView>(w.link(await w.token(s.activity.id, s.peer.id))('GET', ''));
    expect(view).not.toHaveProperty('appraiser');
    expect(view.tasks[0]).not.toHaveProperty('role');
    expect(view.tasks[0]!.object).toEqual({ name: '被评价人E', avatar: null });
    const detail = await w.ok<Record<string, unknown>>(
      w.link(await w.token(s.activity.id, s.peer.id))('GET', `/tasks/${s.peerRelation.id}/questionnaires/${s.q.id}`),
    );
    expect(detail).not.toHaveProperty('role');
    expect(detail).not.toHaveProperty('appraiser');
  });

  it('显示固定文字：角色显示为固定文字，不暴露角色名称', async () => {
    const w = await world360(testDb().db, 'n16c');
    const s = await setup(w, { showAppraiserName: false, roleDisplay: 'fixed_text' });
    await w.transition(s.activity.id, 'enable');
    const view = await w.ok<LinkView>(w.link(await w.token(s.activity.id, s.peer.id))('GET', ''));
    expect(view.tasks[0]!.role).toEqual({ name: '评价者' });
  });

  it('被评价人 / 其他评价者用自己的链接读不到别人的评价关系（404），作答页不列出其他评价者', async () => {
    const w = await world360(testDb().db, 'n16d');
    const s = await setup(w, { showAppraiserName: true, roleDisplay: 'name' });
    await w.transition(s.activity.id, 'enable');
    const selfLink = w.link(await w.token(s.activity.id, s.target.id));
    const selfView = await w.ok<LinkView>(selfLink('GET', ''));
    expect(selfView.tasks.map((t) => t.relationId)).toEqual([s.selfRelation.id]);
    expect(JSON.stringify(selfView)).not.toContain('同事甲');
    const probe = await selfLink('GET', `/tasks/${s.peerRelation.id}/questionnaires/${s.q.id}`);
    expect(probe.status).toBe(404);
    const write = await selfLink('PUT', `/tasks/${s.peerRelation.id}/questionnaires/${s.q.id}`, {
      ifMatch: 0,
      body: { answers: [] },
    });
    expect(write.status).toBe(404);
    const subLink = w.link(await w.token(s.activity.id, s.subs[0]!.id));
    expect((await subLink('GET', `/tasks/${s.peerRelation.id}/questionnaires/${s.q.id}`)).status).toBe(404);
    const peerDetail = await w.ok<{ sheet: { revision: number; answers: unknown[] } }>(
      w.link(await w.token(s.activity.id, s.peer.id))('GET', `/tasks/${s.peerRelation.id}/questionnaires/${s.q.id}`),
    );
    expect(peerDetail.sheet).toMatchObject({ revision: 0, answers: [] });
  });

  it('得分接口：非 360 成员 403、无该活动授权的一般管理员 404；评价关系列表同样', async () => {
    const w = await world360(testDb().db, 'n16e');
    const s = await setup(w, {});
    const outsider = await w.member('成员');
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const paths = [
      `/activities/${s.activity.id}/objects/${s.object.id}/scores`,
      `/activities/${s.activity.id}/objects/${s.object.id}/appraisers`,
    ];
    for (const path of paths) {
      expect((await w.as(outsider)('GET', path)).status, path).toBe(403);
      expect((await w.as(general)('GET', path)).status, path).toBe(404);
    }
  });
});

describe('作答页匿名开关穷举：姓名两态 × 角色三模式（DEC-149）', () => {
  const modes = ['name', 'fixed_text', 'hidden'] as const;
  for (const showName of [true, false])
    for (const roleDisplay of modes)
      it(`姓名${showName ? '显示' : '不显示'} × 角色${roleDisplay}：作答页与作答详情一致`, async () => {
        const w = await world360(testDb().db, `n6${showName ? 'y' : 'n'}${roleDisplay.slice(0, 2)}`);
        // 固定文字取角色上的“显示固定文字时展示的内容”
        const peer = w.roles.find((r) => r.code === 'peer')!;
        const current = (
          await w.ok<{ items: { id: string; revision: number }[] }>(w.request('GET', '/roles'))
        ).items.find((r) => r.id === peer.id)!;
        await w.ok(w.request('PUT', `/roles/${peer.id}`, { ifMatch: current.revision, body: { displayText: '同行' } }));
        const s = await setup(w, { showAppraiserName: showName, roleDisplay });
        await w.transition(s.activity.id, 'enable');
        const call = w.link(await w.token(s.activity.id, s.peer.id));
        const view = await w.ok<LinkView>(call('GET', ''));
        const detail = await w.ok<Record<string, unknown>>(
          call('GET', `/tasks/${s.peerRelation.id}/questionnaires/${s.q.id}`),
        );
        const expectedRole =
          roleDisplay === 'name' ? { name: '同事' } : roleDisplay === 'fixed_text' ? { name: '同行' } : undefined;
        for (const page of [view, detail] as Record<string, unknown>[]) {
          if (showName) expect(page.appraiser).toEqual({ name: '同事甲', avatar: null });
          else expect(page).not.toHaveProperty('appraiser');
        }
        if (expectedRole) {
          expect(view.tasks[0]!.role).toEqual(expectedRole);
          expect(detail.role).toEqual(expectedRole);
        } else {
          expect(view.tasks[0]).not.toHaveProperty('role');
          expect(detail).not.toHaveProperty('role');
        }
        // 无论开关如何，作答页都不出现其他评价者
        expect(JSON.stringify(view)).not.toContain('下级0');
      });
});

describe('身份重叠', () => {
  it('确认人兼评价者：确认令牌只能走确认接口，作答令牌只能走作答接口（互访 404）；作答页只见本人任务', async () => {
    const w = await world360(testDb().db, 'n16o');
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity({ showAppraiserName: false, roleDisplay: 'hidden' });
    const boss = await w.person('上级兼评价者');
    const target = await w.person('被评价人', { superiorPersonId: boss.id });
    const object = await w.object(activity.id, target.id, [q.id]);
    const peer = await w.person('同事乙');
    await w.appraiser(activity.id, object.id, peer.id, 'peer');
    const bossRel = await w.appraiser(activity.id, object.id, boss.id, 'superior');
    await w.ok(
      w.request('POST', `/activities/${activity.id}/objects/${object.id}/confirmation`, { ifMatch: 0, body: {} }),
      201,
    );
    await w.transition(activity.id, 'enable');
    const confirm = w.link(await w.token(activity.id, boss.id, 'survey360.confirm_invitation'));
    const answer = w.link(await w.token(activity.id, boss.id));
    // 确认页按设计列出该对象全部评价者（确认人负责设置评价关系），不受作答页匿名开关影响
    const confirmView = await w.ok<{ appraisers: { appraiserPersonId: string }[] }>(confirm('GET', ''));
    expect(confirmView.appraisers.map((a) => a.appraiserPersonId).sort()).toEqual([boss.id, peer.id].sort());
    // 作答页只见本人任务，匿名开关关闭时没有姓名与角色
    const answerView = await w.ok<LinkView>(answer('GET', ''));
    expect(answerView.tasks.map((t) => t.relationId)).toEqual([bossRel.id]);
    expect(JSON.stringify(answerView)).not.toContain('同事乙');
    expect((await confirm('GET', `/tasks/${bossRel.id}/questionnaires/${q.id}`)).status).toBe(404);
    expect((await answer('GET', '/confirmation/candidates')).status).toBe(404);
  });
});
