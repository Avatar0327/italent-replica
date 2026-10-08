/**
 * R3-T03 PR-B 邀请与待办（`25` §10.1～10.3，Q-M0-127 ①②③⑨；开工通知：站内只用“待办”）：
 * - 待办按评价者 × 活动一条：重发覆盖原条、刷新发送时间；只发给未完成且属于组织员工（有账号）的评价者，全不符合时报原站
 *   文案；标题“请你进行”、正文为活动名称；提交全部对象后自动“已处理”；取消待办只撤提醒，作答入口仍可进入；
 * - 待办“去处理”以登录账号本人作答，与链接作答同一套页面与命令；别人的待办 404；
 * - 邮件邀请重发轮换令牌（同一时刻一个评价者一个有效链接）；只发未完成的评价者；
 * - 进程控制：最后发送时间（邮件、待办都计入）、进度、总进度；停用后不能发送 / 取消待办，作答写入 409。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, key, my, outbox, progress, sceneB, type TodoView, TODO_NOT_ELIGIBLE } from './AC-360-B-support.js';

const testDb = useTestDb();

describe('PR-B 站内待办', () => {
  it('发送、去重、本人作答完成、取消后仍可进入、全不符合时拦截', async () => {
    const s = await sceneB(testDb().db, 'b01a');
    const { w } = s;
    const send = (personIds?: string[]) =>
      w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: personIds ? { personIds } : {} });

    // 外部客户 X 没有组织员工 / 账号，不发；其余 4 人（自评、上级、两名同事）发出
    const first = await w.ok<{ sent: number; message: string }>(send());
    expect(first).toEqual({ sent: 4, message: '系统将陆续给4名评价者发送待办。' });

    const p1 = my(w, s.user.P1);
    const listed = await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'));
    expect(listed.items).toHaveLength(1);
    const todo = listed.items[0]!;
    expect(todo).toMatchObject({ activityId: s.activity.id, title: '请你进行', content: s.activity.name });
    expect(todo.status).toBe('open');
    expect(todo.sentAt).toBe('2026-10-01T01:00:00.000Z');

    // 重发：仍只有一条，发送时间刷新为最近一次
    w.setNow('2026-10-01T03:00:00Z');
    expect(await w.ok(send([s.person.P1.id]))).toEqual({ sent: 1, message: '系统将陆续给1名评价者发送待办。' });
    const again = (await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items;
    expect(again.map((t) => [t.id, t.sentAt])).toEqual([[todo.id, '2026-10-01T03:00:00.000Z']]);

    // 别人的待办：不存在与不属于本人同一 404
    const p2 = my(w, s.user.P2);
    expect((await p2('GET', `/todos/${todo.id}/answer`)).status).toBe(404);
    expect((await p2('GET', `/todos/${crypto.randomUUID()}/answer`)).status).toBe(404);

    // 本人经待办作答：与链接作答同一套页面（匿名开关同样生效），提交全部对象后待办自动“已处理”
    const page = await w.ok<{ tasks: { relationId: string; questionnaires: { id: string }[] }[] }>(
      p1('GET', `/todos/${todo.id}/answer`),
    );
    expect(page.tasks.map((t) => t.relationId)).toEqual([s.rel.p1.id]);
    const task = `/todos/${todo.id}/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
    const option = s.q.scales[0]!.options.find((o) => o.key === 'v4')!.id;
    const saved = await w.ok<{ revision: number }>(
      p1('PUT', task, {
        ifMatch: 0,
        body: { answers: s.q.questions.map((x) => ({ itemId: x.id, optionId: option })) },
      }),
    );
    await w.ok(p1('POST', `${task}/submit`, { ifMatch: saved.revision }));
    const done = (await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items[0]!;
    expect(done.status).toBe('done');
    expect(done.doneAt).toBe('2026-10-01T03:00:00.000Z');

    // 已完成的评价者不能再发；外部客户不能发：全不符合时报原站文案，数据不变
    for (const ids of [[s.person.P1.id], [s.person.X.id], [crypto.randomUUID()]]) {
      const res = await send(ids);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({
        message: TODO_NOT_ELIGIBLE,
        details: { reason: 'TODO_NOT_ELIGIBLE' },
      });
    }
    expect((await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items[0]!.status).toBe('done');

    // 取消待办：移入“已处理”，但仍能从“查看详情”进入作答并保存
    const cancelled = await w.ok<{ cancelled: number; message: string }>(
      w.request('POST', `${s.path}/todos/cancel`, { idempotencyKey: key(), body: { personIds: [s.person.P2.id] } }),
    );
    expect(cancelled).toEqual({ cancelled: 1, message: '系统将陆续取消1名评价者与当前活动相关的待办。' });
    const p2Todo = (await w.ok<{ items: TodoView[] }>(p2('GET', '/todos'))).items[0]!;
    expect(p2Todo.status).toBe('done');
    const p2Task = `/todos/${p2Todo.id}/tasks/${s.rel.p2.id}/questionnaires/${s.q.id}`;
    await w.ok(p2('GET', `/todos/${p2Todo.id}/answer`));
    await w.ok(p2('PUT', p2Task, { ifMatch: 0, body: { answers: [] } }));

    // 再次发送给取消过、尚未完成的 P2：同一条重新打开
    await w.ok(send([s.person.P2.id]));
    const reopened = (await w.ok<{ items: TodoView[] }>(p2('GET', '/todos'))).items;
    expect(reopened.map((t) => [t.id, t.status])).toEqual([[p2Todo.id, 'open']]);
  });

  it('停用后不能发送 / 取消待办，待办作答写入 409，读取仍可进入', async () => {
    const s = await sceneB(testDb().db, 'b01b');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: {} }));
    const p1 = my(w, s.user.P1);
    const todo = (await w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items[0]!;
    await w.transition(s.activity.id, 'disable');
    for (const path of ['/todos', '/todos/cancel', '/invitations']) {
      const res = await w.request('POST', `${s.path}${path}`, { idempotencyKey: key(), body: {} });
      expect(res.status, path).toBe(409);
      expect((await errorOf(res)).details?.reason).toBe('ACTIVITY_NOT_OPEN');
    }
    await w.ok(p1('GET', `/todos/${todo.id}/answer`));
    const task = `/todos/${todo.id}/tasks/${s.rel.p1.id}/questionnaires/${s.q.id}`;
    const res = await p1('PUT', task, { ifMatch: 0, body: { answers: [] } });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ message: '活动暂停中，请稍后评价' });
  });

  it('没有 360 身份的成员只能看自己的待办；管理端接口 403', async () => {
    const s = await sceneB(testDb().db, 'b01c');
    const { w } = s;
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: {} }));
    const t = my(w, s.user.T);
    const items = (await w.ok<{ items: TodoView[] }>(t('GET', '/todos'))).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual([
      'activityId',
      'content',
      'doneAt',
      'id',
      'sentAt',
      'status',
      'title',
    ]);
    expect((await w.as(s.user.T)('GET', `${s.path}/progress`)).status).toBe(403);
    expect((await w.as(s.user.T)('POST', `${s.path}/todos`, { idempotencyKey: key(), body: {} })).status).toBe(403);
  });
});

describe('PR-B 邮件邀请与进程控制', () => {
  it('重发邮件轮换令牌，只发未完成者；最后发送时间、进度、总进度', async () => {
    const s = await sceneB(testDb().db, 'b01d');
    const { w } = s;
    const oldToken = await w.token(s.activity.id, s.person.X.id);
    await s.answerAs(s.person.M.id, s.rel.superior.id, ['v4', 'v4', 'v4']);

    w.setNow('2026-10-01T05:00:00Z');
    const invite = (personIds: string[]) =>
      w.request('POST', `${s.path}/invitations`, { idempotencyKey: key(), body: { personIds } });
    expect(await w.ok(invite([s.person.X.id, s.person.M.id]))).toEqual({ sent: 1 });
    const mails = (await outbox(w, 'survey360.answer_invitation')).filter((m) => m.payload.personId === s.person.X.id);
    expect(mails).toHaveLength(2);
    const newToken = mails[1]!.payload.token;
    expect(newToken).not.toBe(oldToken);
    expect((await w.link(oldToken)('GET', '')).status).toBe(404);
    await w.ok(w.link(newToken)('GET', ''));
    // 只选了已完成的上级：全不符合
    const none = await invite([s.person.M.id]);
    expect(none.status).toBe(409);
    expect((await errorOf(none)).details?.reason).toBe('NO_ELIGIBLE_APPRAISER');

    // 待办也计入最后发送时间
    w.setNow('2026-10-01T06:00:00Z');
    await w.ok(w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: { personIds: [s.person.P1.id] } }));

    const view = await progress(s);
    expect(view.total).toEqual({ completed: 1, all: 5 });
    const row = (id: string) => view.items.find((i) => i.personId === id)!;
    expect(row(s.person.M.id)).toMatchObject({
      status: 'completed',
      progress: { done: 1, total: 1 },
      lastSentAt: '2026-10-01T01:00:00.000Z',
      todo: null,
    });
    expect(row(s.person.X.id)).toMatchObject({
      status: 'not_started',
      lastSentAt: '2026-10-01T05:00:00.000Z',
      emailState: 'pending',
    });
    expect(row(s.person.P1.id)).toMatchObject({ lastSentAt: '2026-10-01T06:00:00.000Z', todo: 'open' });
    expect(row(s.person.P1.id).name).toBe('同事一');
  });
});
