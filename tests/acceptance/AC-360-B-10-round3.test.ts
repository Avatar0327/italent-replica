/**
 * PR #125 第 3 轮修改清单（依据第 2 轮审查，head 1cf73d8）：
 * - P2-1：作答入口（待办 / 链接）的失败审计带评价者的真实账号、作答路径、来源与命令 ID——持“全部活动”但兼任该
 *   活动被评价人 / 评价者的人看不到（不兼任的 360 系统管理员照旧可见，PR-A 口径）；
 * - P2-2（DEC-340③）：管理员对具名评价者“重新作答”后，不能凭自己的命令 ID、匿名卡片编号或清除快照，把原匿名答卷的
 *   逐题答案、评语对应到该评价者——脱敏出口不带命令 ID、答卷编号，清除事件不带答案与评语，按命令 ID / 对象编号 /
 *   来源筛选也查不到答卷日志（数据库里的删除快照照常保存）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { key, my, progressDetail, sceneB, type SceneB, sheets, type TodoView } from './AC-360-B-support.js';

const testDb = useTestDb();

const audit = (s: SceneB) => auditApi(s.w.db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });

async function grantActivity(s: SceneB, user: string) {
  const current = await s.w.getActivity(s.activity.id);
  await s.w.ok(s.w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }));
}

describe('第 3 轮 P2-1：作答入口的失败审计不给兼任者', () => {
  it('被评价人兼持“全部活动”：看不到评价者从待办 / 链接作答失败的审计；不兼任的 360 系统管理员照旧可见', async () => {
    const s = await sceneB(testDb().db, 'r3a');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }));
    const p1 = my(w, s.user.P1);
    const todo = (await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items[0]!;
    const task = `/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
    // 待办保存、待办提交、链接提交各失败一次（revision 冲突 / 校验失败）
    expect(
      (await p1('PUT', `/todos/${todo.id}${task}`, { ifMatch: 7, body: { answers: [] } })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await p1('POST', `/todos/${todo.id}${task}/submit`, { ifMatch: 7, body: {} })).status,
    ).toBeGreaterThanOrEqual(400);
    const link = w.link(await w.token(s.activity.id, s.person.P1.id));
    expect((await link('POST', `${task}/submit`, { ifMatch: 7, body: {} })).status).toBeGreaterThanOrEqual(400);

    // 被评价人 T 同时是 360 系统管理员（持“全部活动”）
    await w.appoint(s.user.T, 'system');
    const failures = async (user: string) =>
      (await audit(s).commandFailures({ user, tenant: w.tenantId }, { limit: '100' })).items.filter((i) =>
        /\/survey360\/(my|link)\//.test(i.path ?? ''),
      );
    expect(await failures(s.user.T)).toEqual([]);
    expect((await failures(w.admin)).length).toBeGreaterThanOrEqual(3);
  });
});

describe('第 3 轮 P2-2：具名清除命令不能关联脱敏审计中的答案', () => {
  it('活动管理员对具名 P1 重新作答：凭命令 ID、匿名卡片编号、清除快照都关联不到 P1 的答卷', async () => {
    const s = await sceneB(testDb().db, 'r3b');
    const { w } = s;
    await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '自评建议' });
    await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: '同事一的评语' });
    await s.answerAs(s.person.P2.id, s.rel.p2.id, ['v2', 'v5', 'v3'], { suggestion: '同事二的评语' });
    await w.transition(s.activity.id, 'disable');
    // 被评价人 T 兼任获授权的一般活动管理员
    await w.appoint(s.user.T, 'general');
    await grantActivity(s, s.user.T);
    const asT = w.as(s.user.T);
    // DEC-358②：T 是一般活动管理员（且兼任被评价人），看不到逐份卡片；卡片编号由系统管理员取来，核对审计里也不出现
    expect((await asT('GET', `${s.path}/sheets`)).status).toBe(403);
    const cards = await sheets(s, w.admin);
    const [p1Sheet] = await withTenant(w.db, w.tenantId, async (tx) => {
      const found = await tx.execute(sql`SELECT id FROM survey360_sheets WHERE relation_id = ${s.rel.p1.id}::uuid`);
      return (Array.isArray(found) ? found : (found as { rows: unknown[] }).rows) as { id: string }[];
    });
    expect(cards.map((c) => c.id)).toContain(p1Sheet!.id);

    const row = (await progressDetail(s, s.person.P1.id, s.user.T)).items[0]!;
    const command = key();
    await w.ok(
      asT('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision, idempotencyKey: command }),
    );

    const as = { user: s.user.T, tenant: w.tenantId };
    const api = audit(s);
    const sheetLogs = async (query: Record<string, string>) =>
      (await api.dataChanges(as, { limit: '100', ...query })).items.filter((i) => i.objectType === 'survey360-sheet');
    // ① 凭自己的命令 ID、② 凭匿名卡片编号筛选：都查不到答卷日志
    expect(await sheetLogs({ commandId: command })).toEqual([]);
    expect(await sheetLogs({ objectId: p1Sheet!.id })).toEqual([]);
    // ③ 列表与详情都不带命令 ID、答卷编号；清除事件不带答案与评语
    const all = await sheetLogs({});
    const cleared = all.filter((i) => i.action === 'survey360.sheet.clear');
    expect(cleared.length).toBeGreaterThan(0);
    for (const item of all) {
      const detail = await api.dataChange(as, item.id);
      for (const view of [item, detail]) {
        expect(view.commandId, item.action).toBeNull();
        expect(view.objectId, item.action).toBeNull();
      }
      const text = JSON.stringify(detail);
      for (const card of cards) expect(text, `${item.action} 卡片编号`).not.toContain(card.id);
      if (item.action !== 'survey360.sheet.clear') continue;
      expect(text).not.toContain('"answers"');
      expect(text).not.toContain('"suggestion"');
      expect(text).not.toContain('同事一的评语');
    }
    // 数据库里的删除快照照常保存（只有出口脱敏）
    const [stored] = await withTenant(w.db, w.tenantId, async (tx) => {
      const found = await tx.execute(sql`SELECT before FROM audit_events
        WHERE action = 'survey360.sheet.clear' AND command_id = ${command}`);
      return (Array.isArray(found) ? found : (found as { rows: unknown[] }).rows) as {
        before: { suggestion: string };
      }[];
    });
    expect(stored!.before.suggestion).toBe('同事一的评语');
  });
});
