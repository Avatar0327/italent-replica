/**
 * DEC-340③：答卷审计（保存、提交、屏蔽、恢复、清除）给有活动授权的管理员看**脱敏版本**——不带任何能关联到评价者的
 * 信息：评价关系 ID、评价者人员 ID / 姓名 / 邮箱 / 账号，以及作答请求的来源（IP、终端、来源页、TraceID、命令 ID）。
 * 持“全部活动”者兼任评价者时不豁免，同样只看脱敏版本；没有活动授权的管理员看不到；作答入口（链接 / 待办）的失败
 * 审计仍只给持“全部活动”者（第 2 轮 P2-1 的反例保持拒绝）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { key, my, progressDetail, sceneB, type SceneB, sheets, type TodoView } from './AC-360-B-support.js';

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

async function sheetEvents(s: SceneB, user: string) {
  const audit = auditApi(s.w.db, '2026-10-01T02:00:00Z', { authorize: s.w.authorize });
  const as = { user, tenant: s.w.tenantId };
  const items = (await audit.dataChanges(as, { limit: '100' })).items.filter((i) => i.objectType === 'survey360-sheet');
  return Promise.all(items.map(async (item) => ({ item, detail: await audit.dataChange(as, item.id) })));
}

function expectDesensitized(s: SceneB, events: Awaited<ReturnType<typeof sheetEvents>>) {
  const markers = identityMarkers(s);
  for (const { item, detail } of events) {
    const text = JSON.stringify([item, detail]);
    expect(text, item.action).not.toContain('"relationId"');
    for (const marker of markers) expect(text, `${item.action} ${marker}`).not.toContain(marker);
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

  it('持“全部活动”者兼任评价者时不豁免：同样只看脱敏版本', async () => {
    const s = await scene('d340b');
    // 上级 M 是本活动的评价者，同时持“全部活动”（360 系统管理员身份）
    await s.w.appoint(s.user.M, 'system');
    const events = await sheetEvents(s, s.user.M);
    const actions = new Set(events.map((e) => e.item.action));
    for (const action of ACTIONS) expect(actions, action).toContain(action);
    expectDesensitized(s, events);
    // 不兼任的“全部活动”持有人（租户 360 系统管理员）同一脱敏口径
    expectDesensitized(s, await sheetEvents(s, s.w.admin));
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
