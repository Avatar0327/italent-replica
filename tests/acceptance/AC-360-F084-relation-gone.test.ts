/**
 * F-084（DEC-379④，信息泄露）：评价者在活动内已没有任何有效评价关系后，个人作答链接与站内待办两个入口的
 * 主页、本人头像、任务读写与我的待办列表，一律与“链接无效”同一 404（口径同 answering.ts notFound：
 * 链接无效或已失效），不再返回活动名称、欢迎语、状态或评价者本人头像。
 * 两个原因：删除评价者最后一条评价关系；移除评价者最后一个评价对象（对象下的关系随之移除）。
 * 反向对照：评价者在本活动仍有其他有效评价关系时入口照常；其他评价者不受影响。
 * 不受影响：匿名口径（DEC-149）下的作答页字段、F-060 报告转发的收件人链接、确认链接。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employeeAvatar } from './AC-EMP-F058-avatar-support.js';
import { key, my, outbox, reportLink, reports, sceneB, type SceneB, type TodoView } from './AC-360-B-support.js';
import type { ObjectView, RelationView } from './AC-360-support.js';

const testDb = useTestDb();

const NOT_FOUND = { code: 'NOT_FOUND', message: '链接无效或已失效' };

type Reason = 'relation' | 'object';
const REASONS: readonly Reason[] = ['relation', 'object'];

/** 场景：同事一（P1）只评价 T；另建对象 M（直线经理）让 P1 或 P2 在第二个对象上有“其他关系”。 */
async function scene(label: string, activityBody: Record<string, unknown> = {}) {
  const s = await sceneB(testDb().db, label, activityBody);
  const avatar = (await employeeAvatar(s.w, s.employees.P1.id)).avatar;
  const targetAvatar = (await employeeAvatar(s.w, s.employees.T.id)).avatar;
  await s.w.ok(s.w.request('POST', `${s.path}/todos`, { idempotencyKey: key(), body: {} }));
  const token = await s.w.token(s.activity.id, s.person.P1.id);
  const todo = (await s.w.ok<{ items: TodoView[] }>(my(s.w, s.user.P1)('GET', '/todos'))).items[0]!;
  return { s, avatar, targetAvatar, token, todo };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** 给 P1 在第二个评价对象（经理 M）上再建一条关系，作为“仍有其他关系”的对照。 */
async function addSecondObject(s: SceneB) {
  const object = await s.w.object(s.activity.id, s.person.M.id, [s.q.id]);
  const relation = await s.w.appraiser(s.activity.id, object.id, s.person.P1.id, 'peer');
  return { object, relation };
}

const currentObject = async (s: SceneB, id: string) =>
  (await s.w.ok<{ items: ObjectView[] }>(s.w.request('GET', `${s.path}/objects`))).items.find((o) => o.id === id)!;

async function removeRelation(s: SceneB, objectId: string, relation: RelationView) {
  const list = await s.w.ok<{ items: RelationView[] }>(s.w.request('GET', `${s.path}/objects/${objectId}/appraisers`));
  const live = list.items.find((r) => r.id === relation.id)!;
  await s.w.ok(
    s.w.request('DELETE', `${s.path}/objects/${objectId}/appraisers/${relation.id}`, { ifMatch: live.revision }),
  );
}

async function removeObject(s: SceneB, objectId: string) {
  const object = await currentObject(s, objectId);
  await s.w.ok(s.w.request('DELETE', `${s.path}/objects/${objectId}`, { ifMatch: object.revision }));
}

/** 按原因把 P1 在 T 上的唯一关系去掉（关系 / 对象）。 */
async function drop(sc: Scene, reason: Reason) {
  if (reason === 'relation') await removeRelation(sc.s, sc.s.object.id, sc.s.rel.p1);
  else await removeObject(sc.s, sc.s.object.id);
}

interface Entry {
  readonly name: string;
  readonly call: (sc: Scene, method: string, path: string, body?: unknown) => Promise<Response>;
  readonly base: (sc: Scene) => string;
}

const ENTRIES: readonly Entry[] = [
  {
    name: '个人链接',
    call: (sc, method, path, body) =>
      sc.s.w.link(sc.token)(method, path, body === undefined ? {} : { ifMatch: 0, body }),
    base: () => '',
  },
  {
    name: '待办',
    call: (sc, method, path, body) =>
      my(sc.s.w, sc.s.user.P1)(method, `/todos/${sc.todo.id}${path}`, body === undefined ? {} : { ifMatch: 0, body }),
    base: () => '/answer',
  },
];

const home = (e: Entry, sc: Scene) => e.call(sc, 'GET', e.base(sc));
const task = (sc: Scene) => `/tasks/${sc.s.rel.p1.id}/questionnaires/${sc.s.q.id}`;
const avatarPath = (sc: Scene, id: string) => `/avatars/${id}/content`;

async function expectGone(res: Response, label: string) {
  expect(res.status, label).toBe(404);
  expect(await res.json(), label).toMatchObject({ error: NOT_FOUND });
}

describe.each(ENTRIES)('F-084 $name：最后一条关系消失后一律拒绝', (entry) => {
  it.each(REASONS)('原因 %s：主页、本人头像、任务读写均 404 且不含活动信息', async (reason) => {
    const sc = await scene(`f84-${entry.name === '待办' ? 't' : 'l'}-${reason}`);
    // 先确认关系存在时入口正常（红绿对照的“绿”侧基线）
    const before = await sc.s.w.ok<{ activity: { name: string }; appraiser: { avatar: unknown } }>(home(entry, sc));
    expect(before.activity.name).toBe(sc.s.activity.name);
    expect((await entry.call(sc, 'GET', avatarPath(sc, sc.avatar.id))).status).toBe(200);

    await drop(sc, reason);

    const page = await home(entry, sc);
    await expectGone(page, '主页');
    expect(JSON.stringify(await (await home(entry, sc)).json())).not.toContain(sc.s.activity.name);
    await expectGone(await entry.call(sc, 'GET', avatarPath(sc, sc.avatar.id)), '本人头像');
    await expectGone(await entry.call(sc, 'GET', avatarPath(sc, sc.targetAvatar.id)), '原评价对象头像');
    await expectGone(await entry.call(sc, 'GET', task(sc)), '任务读取');
    await expectGone(await entry.call(sc, 'PUT', task(sc), { answers: [] }), '任务保存');
    await expectGone(await entry.call(sc, 'POST', `${task(sc)}/submit`, {}), '任务提交');
  });

  it.each(REASONS)('原因 %s 的反向对照：仍有其他关系的评价者入口照常，对象头像只给仍有效的', async (reason) => {
    const sc = await scene(`f84-ctl-${entry.name === '待办' ? 't' : 'l'}-${reason}`);
    const second = await addSecondObject(sc.s);
    await drop(sc, reason);

    const page = await sc.s.w.ok<{ activity: { name: string }; tasks: { relationId: string }[] }>(home(entry, sc));
    expect(page.activity.name).toBe(sc.s.activity.name);
    expect(page.tasks.map((t) => t.relationId)).toEqual([second.relation.id]);
    expect((await entry.call(sc, 'GET', avatarPath(sc, sc.avatar.id))).status).toBe(200);
    // 已移除的关系 / 对象仍是 404，剩余关系可读写
    await expectGone(await entry.call(sc, 'GET', task(sc)), '已移除任务');
    const own = `/tasks/${second.relation.id}/questionnaires/${sc.s.q.id}`;
    await sc.s.w.ok(entry.call(sc, 'GET', own));

    // 其余评价者（同事二）不受影响
    const p2 = await sc.s.w.token(sc.s.activity.id, sc.s.person.P2.id);
    expect((await sc.s.w.link(p2)('GET', '')).status).toBe(200);

    // 再去掉最后一条：同样拒绝
    if (reason === 'relation') await removeRelation(sc.s, second.object.id, second.relation);
    else await removeObject(sc.s, second.object.id);
    await expectGone(await home(entry, sc), '第二次去掉后主页');
    await expectGone(await entry.call(sc, 'GET', avatarPath(sc, sc.avatar.id)), '第二次去掉后本人头像');
  });

  it('与不存在的链接 / 待办同一 404 响应体，不能据此探测评价者曾有关系', async () => {
    const sc = await scene(`f84-same-${entry.name === '待办' ? 't' : 'l'}`);
    await drop(sc, 'relation');
    const gone = await home(entry, sc);
    const bogus =
      entry.name === '待办'
        ? await my(sc.s.w, sc.s.user.P1)('GET', `/todos/${crypto.randomUUID()}/answer`)
        : await sc.s.w.link('no-such-token')('GET', '');
    expect(gone.status).toBe(bogus.status);
    expect(await gone.json()).toEqual(await bogus.json());
  });
});

describe('F-084 我的待办列表', () => {
  it.each(REASONS)('原因 %s：没有有效关系的待办不再出现在列表里，仍有关系的照常', async (reason) => {
    const sc = await scene(`f84-list-${reason}`);
    const second = await addSecondObject(sc.s);
    const p1 = my(sc.s.w, sc.s.user.P1);
    expect((await sc.s.w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items).toHaveLength(1);

    await drop(sc, reason);
    expect((await sc.s.w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items).toHaveLength(1);

    if (reason === 'relation') await removeRelation(sc.s, second.object.id, second.relation);
    else await removeObject(sc.s, second.object.id);
    expect((await sc.s.w.ok<{ items: TodoView[] }>(p1('GET', '/todos'))).items).toEqual([]);
    // 其他评价者的待办不受影响
    const p2 = my(sc.s.w, sc.s.user.P2);
    expect((await sc.s.w.ok<{ items: TodoView[] }>(p2('GET', '/todos'))).items).toHaveLength(1);
  });
});

describe('F-084 不受影响的口径', () => {
  it('DEC-149 匿名活动：仍有关系时作答页照旧按开关缺席，关系消失后同样 404', async () => {
    const sc = await scene('f84-anon', { showAppraiserName: false, roleDisplay: 'hidden' });
    const second = await addSecondObject(sc.s);
    await removeRelation(sc.s, sc.s.object.id, sc.s.rel.p1);
    const page = await sc.s.w.ok<{ appraiser?: unknown; tasks: { role?: unknown }[] }>(
      sc.s.w.link(sc.token)('GET', ''),
    );
    expect('appraiser' in page).toBe(false);
    expect(page.tasks.every((t) => !('role' in t))).toBe(true);
    await removeRelation(sc.s, second.object.id, second.relation);
    expect((await sc.s.w.link(sc.token)('GET', '')).status).toBe(404);
  });

  it('F-060 报告转发的收件人链接在评价关系消失后不受影响', async () => {
    const sc = await scene('f84-report');
    const { s } = sc;
    await s.answerAs(s.person.P1.id, s.rel.p1.id, ['v4', 'v4', 'v4']);
    await s.w.transition(s.activity.id, 'disable');
    await s.w.ok(s.w.request('POST', `${s.path}/reports/generate`, { idempotencyKey: key(), body: {} }));
    await s.w.ok(
      s.w.request('POST', `${s.path}/reports/forward`, {
        idempotencyKey: key(),
        body: { mode: 'others', others: [{ name: 'HRBP', email: 'hrbp-f84@example.com' }] },
      }),
    );
    const [mail] = await outbox(s.w, 'survey360.report_forward');
    const call = reportLink(s.w, mail!.payload.token);
    const [row] = await reports(s);
    expect((await call('GET', `/reports/${row!.id}`)).status).toBe(200);
    await removeRelation(s, s.object.id, s.rel.p1);
    // 评价者 P1 的作答入口拒绝；收件人链接读到的报告与删除前一致（报告已生成，按原有口径）
    expect((await s.w.link(sc.token)('GET', '')).status).toBe(404);
    expect((await call('GET', '')).status).toBe(200);
  });

  it('已删除任务的详情保持原有拒绝；确认链接口径不变', async () => {
    const sc = await scene('f84-keep');
    const { s } = sc;
    await removeRelation(s, s.object.id, s.rel.superior);
    // 其他评价者（同事二）不受影响，且不能读他人已删除的任务
    const p2 = await s.w.token(s.activity.id, s.person.P2.id);
    expect((await s.w.link(p2)('GET', '')).status).toBe(200);
    expect((await s.w.link(p2)('GET', `/tasks/${s.rel.superior.id}/questionnaires/${s.q.id}`)).status).toBe(404);
  });
});
