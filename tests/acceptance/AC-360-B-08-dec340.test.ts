/**
 * DEC-340③ / DEC-355②：答卷审计（保存、提交、屏蔽、恢复、清除）给有活动授权的管理员看**脱敏版本**——不带任何能
 * 关联到评价者的信息：评价关系 ID、评价者人员 ID / 姓名 / 邮箱 / 账号，也不展示请求来源（IP、终端、来源页、TraceID）、
 * 命令 ID 与答卷编号（第 3 轮 P2-2：管理员可凭自己的命令 ID 或匿名卡片编号把答卷关联到具名评价关系）。
 * DEC-355②（批准例外）：持“全部活动”且**在该活动里**不兼任被评价人 / 评价者的人看完整版（评价关系、答案、来源）；
 * 兼任者与其他活动管理员看脱敏版。没有活动授权的管理员看不到；作答入口（链接 / 待办）的失败审计仍只给持“全部活动”
 * 且不兼任任何活动的人（第 3 轮 P2-1）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { key, my, progressDetail, sceneB, type SceneB, sheets, type TodoView, userOf } from './AC-360-B-support.js';

const testDb = useTestDb();

/** 三人提交后停用；屏蔽 → 取消屏蔽、屏蔽 → 恢复全部、清除一行，三类答卷事件都有。 */
async function scene(label: string) {
  const s = await sceneB(testDb().db, label);
  const { w } = s;
  await s.answerAs(s.person.T.id, s.rel.self.id, ['v5', 'v4', 'v4'], { suggestion: '自评建议' });
  await s.answerAs(s.person.M.id, s.rel.superior.id, ['v3', 'v4', 'v5'], { suggestion: '上级建议' });
  await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v3', 'v4'], { suggestion: '同事建议' });
  await w.transition(s.activity.id, 'disable');
  const card = (await sheets(s))[0]!;
  await w.ok(w.request('POST', `${s.path}/sheets/${card.id}/block`, { ifMatch: card.revision }));
  const blocked = (await sheets(s)).find((c) => c.id === card.id)!;
  await w.ok(w.request('POST', `${s.path}/sheets/${card.id}/unblock`, { ifMatch: blocked.revision }));
  const again = (await sheets(s)).find((c) => c.id === card.id)!;
  await w.ok(w.request('POST', `${s.path}/sheets/${card.id}/block`, { ifMatch: again.revision }));
  await w.ok(w.request('POST', `${s.path}/sheets/unblock-all`, { idempotencyKey: key(), body: {} }));
  const row = (await progressDetail(s, s.person.P1.id)).items[0]!;
  await w.ok(w.request('POST', `${s.path}/relations/${row.relationId}/reanswer`, { ifMatch: row.revision }));
  return s;
}

async function grantActivity(s: SceneB, user: string) {
  const current = await s.w.getActivity(s.activity.id);
  await s.w.ok(s.w.request('POST', `${s.path}/grants`, { ifMatch: current.revision, body: { userIds: [user] } }));
}

/** 能关联到评价者的标记：评价关系 ID、评价者人员 ID / 姓名 / 邮箱、评价者账号。 */
function identityMarkers(s: SceneB): string[] {
  const people = [s.person.T, s.person.M, s.person.P1, s.person.P2];
  return [
    ...Object.values(s.rel).map((r) => r.id),
    ...people.flatMap((p) => [p.id, p.name, p.email]),
    ...Object.values(s.user),
  ];
}

async function sheetEvents(s: SceneB, user: string, query: Record<string, string> = {}) {
  const audit = auditApi(s.w.db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });
  const as = { user, tenant: s.w.tenantId };
  const items = (await audit.dataChanges(as, { limit: '100', ...query })).items.filter(
    (i) => i.objectType === 'survey360-sheet',
  );
  return Promise.all(items.map(async (item) => ({ item, detail: await audit.dataChange(as, item.id) })));
}

/** 完整版（DEC-355②）：带评价关系、答卷编号、命令 ID，清除事件带答案与评语；可按命令 ID 筛到。 */
async function expectFull(s: SceneB, user: string) {
  const events = await sheetEvents(s, user);
  const actions = new Set(events.map((e) => e.item.action));
  for (const action of ACTIONS) expect(actions, action).toContain(action);
  const text = JSON.stringify(events);
  expect(text).toContain('"relationId"');
  expect(text).toContain(s.rel.p1.id);
  const clear = events.find((e) => e.item.action === 'survey360.sheet.clear')!;
  expect(clear.item.objectId).not.toBeNull();
  expect(clear.item.commandId).not.toBeNull();
  expect(JSON.stringify(clear.detail)).toContain('同事建议');
  const byCommand = await sheetEvents(s, user, { commandId: clear.item.commandId! });
  expect(byCommand.map((e) => e.item.id)).toContain(clear.item.id);
}

function expectDesensitized(s: SceneB, events: Awaited<ReturnType<typeof sheetEvents>>) {
  const markers = identityMarkers(s);
  for (const { item, detail } of events) {
    const text = JSON.stringify([item, detail]);
    expect(text, item.action).not.toContain('"relationId"');
    for (const marker of markers) expect(text, `${item.action} ${marker}`).not.toContain(marker);
    expect(item.objectId, `${item.action} 答卷编号`).toBeNull();
    for (const view of [item, detail])
      expect(
        {
          ip: view.ip,
          traceId: view.traceId,
          terminal: view.terminal,
          sourcePage: view.sourcePage,
          sourceAction: view.sourceAction,
          clientVersion: view.clientVersion,
          commandId: view.commandId,
        },
        item.action,
      ).toEqual({
        ip: null,
        traceId: null,
        terminal: null,
        sourcePage: null,
        sourceAction: null,
        clientVersion: null,
        commandId: null,
      });
  }
}

const ACTIONS = ['survey360.sheet.submit', 'survey360.sheet.block', 'survey360.sheet.unblock', 'survey360.sheet.clear'];

describe('DEC-340③ 答卷审计脱敏', () => {
  it('有活动授权的管理员看到屏蔽 / 恢复 / 清除（与提交）事件，但没有任何评价者身份与作答来源', async () => {
    const s = await scene('d340a');
    const general = await s.w.member('活动管理员');
    await s.w.appoint(general, 'general');
    await grantActivity(s, general);
    const events = await sheetEvents(s, general);
    const actions = new Set(events.map((e) => e.item.action));
    for (const action of ACTIONS) expect(actions, action).toContain(action);
    expectDesensitized(s, events);
  });

  it('兼任本活动评价者 / 被评价人的“全部活动”持有人只看脱敏版本（DEC-355②）', async () => {
    const s = await scene('d340b');
    // 上级 M 是本活动的评价者、T 是被评价人，同时持“全部活动”（360 系统管理员身份）
    for (const user of [s.user.M, s.user.T]) {
      await s.w.appoint(user, 'system');
      const events = await sheetEvents(s, user);
      const actions = new Set(events.map((e) => e.item.action));
      for (const action of ACTIONS) expect(actions, action).toContain(action);
      expectDesensitized(s, events);
      // 脱敏行按命令 ID 筛选查不到（第 3 轮 P2-2 保持）
      const clearedByAdmin = (await sheetEvents(s, s.w.admin)).find((e) => e.item.action === 'survey360.sheet.clear')!;
      expect(await sheetEvents(s, user, { commandId: clearedByAdmin.item.commandId! })).toEqual([]);
    }
  });

  it('持“全部活动”且在本活动不兼任的人看完整版：评价关系、答案、来源与命令 ID（DEC-355②）', async () => {
    const s = await scene('d355');
    const { w } = s;
    // 租户 360 系统管理员（没有挂接任何被评价人 / 评价者）
    await expectFull(s, w.admin);
    // 虚线经理 D 是另一活动的被评价人、不参与本活动：本活动的日志看完整版（按活动判定，不是“任一活动”）
    const other = await w.activity({ name: '另一活动' });
    await w.object(other.id, s.person.D.id, [s.q.id]);
    const d = await userOf(w, s.employees.D.id);
    await w.appoint(d, 'system');
    await expectFull(s, d);
  });

  it('没有活动授权的管理员看不到；作答入口的失败审计对活动管理员仍不可见', async () => {
    const s = await scene('d340c');
    const { w } = s;
    const outsider = await w.member('无授权管理员');
    await w.appoint(outsider, 'general');
    expect(await sheetEvents(s, outsider)).toEqual([]);

    await w.transition(s.activity.id, 'enable');
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }));
    const p1 = my(w, s.user.P1);
    const todo = (await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items[0]!;
    const res = await p1('PUT', `/todos/${todo.id}/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`, {
      ifMatch: 7,
      body: { answers: [] },
    });
    expect(res.status).toBe(409);
    const general = await w.member('活动管理员');
    await w.appoint(general, 'general');
    await grantActivity(s, general);
    const audit = auditApi(w.db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const failures = async (user: string) =>
      (await audit.commandFailures({ user, tenant: w.tenantId }, { limit: '100' })).items.filter((i) =>
        (i.path ?? '').includes('/survey360/my/'),
      );
    expect((await failures(w.admin)).length).toBeGreaterThan(0);
    expect(await failures(general)).toEqual([]);
  });
});
