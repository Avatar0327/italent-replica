/**
 * R3-T03 PR-B 屏蔽无效数据与重新作答（`25` §10.1 ⑥⑦⑧、§10.3 ⑨⑩⑪⑫；AC-360-08）：
 * - 原始数据：停用后每份已提交答卷一张卡片，评价者“保密”（不返回任何评价者标识），未提交的不进；启用中列表为空；
 * - 屏蔽粒度 = 评价者 × 套卷，可取消、可一键恢复；“屏蔽疑似无效数据”2 小时一次；屏蔽不立即重算，启用 → 停用后
 *   被屏蔽答卷不参与计分（AC-360-08）；
 * - 三处口径照原站：进度明细“已评价(被屏蔽)”、进程控制仍算已完成、个人报告评价关系表算未完成；
 * - 重新作答：只对已评价（含被屏蔽）的行；启用中、停用后都可；不重发待办 / 邮件、最后发送时间不变；旧报告失效，
 *   报表在重算前仍是旧结果；进行中（未提交）的行 409。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { overall } from './AC-360-support.js';
import {
  DATA_CHANGED,
  errorOf,
  key,
  outbox,
  progress,
  progressDetail,
  reports,
  sceneB,
  type SceneB,
  sheets,
} from './AC-360-B-support.js';

const testDb = useTestDb();

/** 自评、上级、同事一（全选同一选项）提交；同事二只保存未提交；客户未作答。 */
async function answered(label: string) {
  const s = await sceneB(testDb().db, label);
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4']);
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5']);
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v4']);
  await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v2', 'v2'], { submit: false });
  return s;
}

const peerScore = async (s: SceneB) => overall(await s.w.scores(s.activity.id, s.object.id), 'role', s.w.role('peer'));

describe('PR-B 原始数据与屏蔽', () => {
  it('启用中列表为空、不能屏蔽；停用后评价者保密，未提交不进', async () => {
    const s = await answered('b02a');
    const { w } = s;
    expect(await sheets(s)).toEqual([]);
    await w.transition(s.activity.id, 'disable');
    const cards = await sheets(s);
    expect(cards.map((c) => c.role.name).sort()).toEqual(['上级', '同事', '自评']);
    const text = JSON.stringify(cards);
    for (const secret of [s.person.P1.id, s.person.M.id, s.rel.p1.id, s.rel.superior.id, '同事一', '直线经理'])
      expect(text).not.toContain(secret);
    for (const card of cards) {
      expect(Object.keys(card).sort()).toEqual([
        'blockSource',
        'blocked',
        'id',
        'items',
        'objectId',
        'objectName',
        'questionnaireId',
        'questionnaireName',
        'revision',
        'role',
        'total',
      ]);
    }
    const peer = cards.find((c) => c.role.name === '同事')!;
    expect(peer.total).toBe(4);
    expect(peer.items.map((i) => i.score)).toEqual([4, 4, 4]);

    await w.transition(s.activity.id, 'enable');
    const blocked = await w.request('POST', `${s.path}/sheets/${peer.id}/block`, { ifMatch: peer.revision });
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).details?.reason).toBe('ACTIVITY_NOT_DISABLED');
  });

  it('一键屏蔽疑似无效（同一选项）、2 小时一次；三处口径；重算后不参与计分（AC-360-08）；取消与恢复', async () => {
    const s = await answered('b02b');
    const { w } = s;
    await w.transition(s.activity.id, 'disable');
    expect(await peerScore(s)).toBe(4);

    const suspect = () => w.request('POST', `${s.path}/sheets/block-suspected`, { idempotencyKey: key(), body: {} });
    expect(await w.ok(suspect())).toEqual({ blocked: 1 });
    const limited = await suspect();
    expect(limited.status).toBe(409);
    expect(await errorOf(limited)).toMatchObject({
      message: '此功能2小时内仅允许使用一次',
      details: { reason: 'RATE_LIMITED' },
    });
    const peerCard = (await sheets(s)).find((c) => c.role.name === '同事')!;
    expect(peerCard).toMatchObject({ blocked: true, blockSource: 'suspected' });
    expect((await sheets(s)).filter((c) => c.blocked)).toHaveLength(1);

    // 进度明细：已评价(被屏蔽)；进程控制：仍算已完成，总进度不变
    const detail = await progressDetail(s, s.person.P1.id);
    expect(detail.items.map((i) => i.status)).toEqual(['submitted_blocked']);
    const view = await progress(s);
    expect(view.items.find((i) => i.personId === s.person.P1.id)!.status).toBe('completed');
    expect(view.total).toEqual({ completed: 3, all: 5 });

    // 屏蔽不立即重算；启用 → 停用后同事角色只剩被屏蔽的同事一，整个角色没有有效数据
    expect(await peerScore(s)).toBe(4);
    await w.transition(s.activity.id, 'enable');
    await w.transition(s.activity.id, 'disable');
    expect(await peerScore(s)).toBeNull();

    // 个人报告评价关系表把被屏蔽的算作未完成：同事 完成 0 / 邀请 2
    await w.ok(w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
    const [row] = await reports(s);
    const report = await w.ok<{
      questionnaires: { preface: { relationTable: { roleName: string; completed: number; invited: number }[] } }[];
    }>(w.request('GET', `${s.path}/reports/${row!.id}`));
    const peerRow = report.questionnaires[0]!.preface.relationTable.find((r) => r.roleName === '同事')!;
    expect(peerRow).toMatchObject({ completed: 0, invited: 2 });

    // 两小时后可再用；取消屏蔽单份；恢复全部
    w.setNow('2026-10-01T03:00:01Z');
    expect(await w.ok(suspect())).toEqual({ blocked: 0 });
    const unblocked = await w.ok<{ blocked: boolean }>(
      w.request('POST', `${s.path}/sheets/${peerCard.id}/unblock`, { ifMatch: peerCard.revision }),
    );
    expect(unblocked.blocked).toBe(false);
    const self = (await sheets(s)).find((c) => c.role.name === '自评')!;
    await w.ok(w.request('POST', `${s.path}/sheets/${self.id}/block`, { ifMatch: self.revision }));
    expect(await w.ok(w.request('POST', `${s.path}/sheets/unblock-all`, { idempotencyKey: key(), body: {} }))).toEqual({
      unblocked: 1,
    });
    expect((await sheets(s)).filter((c) => c.blocked)).toEqual([]);
  });
});

describe('PR-B 重新作答', () => {
  it('清除已评价的行：不重发通知、最后发送时间不变、旧报告失效、报表仍旧；未提交的行 409', async () => {
    const s = await answered('b02c');
    const { w } = s;
    await w.transition(s.activity.id, 'disable');
    await w.ok(w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
    const [report] = await reports(s);
    await w.ok(w.request('GET', `${s.path}/reports/${report!.id}`));
    const before = await progress(s);
    const mailsBefore = (await outbox(w, 'survey360.answer_invitation')).length;

    const row = (await progressDetail(s, s.person.M.id)).items[0]!;
    expect(row.status).toBe('submitted');
    w.setNow('2026-10-01T02:00:00Z');
    const cleared = await w.ok<{ status: string }>(
      w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }),
    );
    expect(cleared.status).toBe('not_started');

    const after = await progress(s);
    const m = (v: typeof after) => v.items.find((i) => i.personId === s.person.M.id)!;
    expect(m(after)).toMatchObject({ status: 'not_started', progress: { done: 0, total: 1 } });
    expect(m(after).lastSentAt).toBe(m(before).lastSentAt);
    expect(after.total.completed).toBe(before.total.completed - 1);
    expect((await outbox(w, 'survey360.answer_invitation')).length).toBe(mailsBefore);
    expect((await sheets(s)).map((c) => c.role.name).sort()).toEqual(['同事', '自评']);

    // 旧报告失效：列表行仍在、查看被拦；报表（计分）重算前仍是旧结果；生成也被拦
    const [stale] = await reports(s);
    expect(stale).toMatchObject({ id: report!.id, status: 'outdated' });
    const view = await w.request('GET', `${s.path}/reports/${report!.id}`);
    expect(view.status).toBe(409);
    expect(await errorOf(view)).toMatchObject({ message: DATA_CHANGED, details: { reason: 'DATA_CHANGED' } });
    expect(overall(await w.scores(s.activity.id, s.object.id), 'role', w.role('superior'))).toBe(4.25);
    w.setNow('2026-10-01T05:00:00Z');
    const regenerate = await w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} });
    expect(regenerate.status).toBe(409);
    expect((await errorOf(regenerate)).details?.reason).toBe('DATA_CHANGED');

    // 进行中（保存未提交）的行不可清除，数据不变
    const p2 = (await progressDetail(s, s.person.P2.id)).items[0]!;
    expect(p2.status).toBe('in_progress');
    const refused = await w.request('POST', `${s.path}/relations/${p2.relationId}/reanswer`, { ifMatch: p2.revision });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).details?.reason).toBe('NOT_SUBMITTED');
    expect((await progressDetail(s, s.person.P2.id)).items[0]!.status).toBe('in_progress');

    // 原链接重答：启用后上级可再次作答
    await w.transition(s.activity.id, 'enable');
    await s.answerAs(s.person.M.id, s.rel.superior.id, ['v5', 'v5', 'v5']);
    await w.transition(s.activity.id, 'disable');
    expect(overall(await w.scores(s.activity.id, s.object.id), 'role', w.role('superior'))).toBe(5);
    expect((await reports(s))[0]!.status).toBe('generated');
  });

  it('启用中也可清除；清除后待办不重开', async () => {
    const s = await answered('b02d');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.T.id] } }));
    const row = (await progressDetail(s, s.person.P1.id)).items[0]!;
    await w.ok(w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
    expect((await progress(s)).items.find((i) => i.personId === s.person.P1.id)!.todo).toBeNull();
  });
});
