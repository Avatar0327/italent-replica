/**
 * F-410：按员工查在途退休单（GET /retirements/employees/:id/in-flight）。
 * 员工入口只信页面层缓存的草稿（DEC-727）：另一会话把 A 撤销、本页把 B 撤回成草稿后，入口读到 A 已作废就去新建，
 * 被“已有在途离职”挡住。这个端点让入口先问服务端“这位员工现在有没有在途的退休单”，有草稿就接续。
 * 口径：在途 = 草稿 / 审批中 / 已批准 / 已驳回（与互斥门禁 leavesInProgress 同一集合）；只返回退休单；
 * 单据内容走详情同一裁剪（字段权）；员工范围外与不存在同一个 404（同状态同文案）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { retireBody } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const LATER = '2026-10-25';
const world = (label: string) => retirementCancelWorld(database().db, `f410-${label}`, TODAY);
type World = Awaited<ReturnType<typeof world>>;

async function inFlight(x: World, api = x.session.request, employeeId = x.employee.id) {
  const response = await api('GET', `/retirements/employees/${employeeId}/in-flight`);
  return { status: response.status, text: await response.text() };
}
async function item(x: World, api = x.session.request) {
  const result = await inFlight(x, api);
  expect(result.status, result.text).toBe(200);
  return (JSON.parse(result.text) as { item: Record<string, unknown> | null }).item;
}
const draftOf = (x: World) => x.createdRetire(x.employee.id, retireBody(LATER, 'application'));
async function move(x: World, id: string, action: 'submit' | 'withdraw') {
  const response = await x.session.request('POST', `/retirements/${id}/${action}`, {
    ifMatch: (await x.business(id)).revision,
    body: {},
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

describe('F-410 员工在途退休单查询', () => {
  it('没有退休单 → item 为 null', async () => {
    const x = await world('none');
    expect(await item(x)).toBeNull();
  });

  it('草稿 / 审批中 / 撤回后回到草稿：读到同一张单，内容与退休详情一致', async () => {
    const x = await world('states');
    const draft = await draftOf(x);
    const detail = async () => (await (await x.session.request('GET', `/retirements/${draft.id}`)).json()) as object;
    expect(await item(x)).toEqual(await detail());
    expect(await item(x)).toMatchObject({ id: draft.id, status: 'draft', mode: 'application' });
    await move(x, draft.id, 'submit');
    expect(await item(x)).toMatchObject({ id: draft.id, status: 'in_review' });
    await move(x, draft.id, 'withdraw');
    expect(await item(x)).toEqual(await detail());
    expect(await item(x)).toMatchObject({ id: draft.id, status: 'draft' });
  });

  it('多会话：A 在别处撤销、B 新建并撤回成草稿 → 只返回 B，不返回已作废的 A', async () => {
    const x = await world('multi-session');
    const first = await draftOf(x);
    await x.retireCancelled(first.id);
    expect(await item(x)).toBeNull();
    const second = await draftOf(x);
    await move(x, second.id, 'submit');
    await move(x, second.id, 'withdraw');
    expect(await item(x)).toMatchObject({ id: second.id, status: 'draft' });
  });

  it('在途的离职单不算退休单：item 为 null', async () => {
    const x = await world('not-retirement');
    const leave = await x.directLeave(LATER);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    expect(await item(x)).toBeNull();
  });

  it('员工范围外与不存在同一个 404（同状态同文案）；没有任职记录查看权 403', async () => {
    const x = await world('scope');
    await draftOf(x);
    const nobody = x.restricted(denyButtons(), '00000000-0000-4000-8000-000000000001');
    const outside = await inFlight(x, nobody);
    const missing = await inFlight(x, nobody, '00000000-0000-4000-8000-0000000000aa');
    expect(outside.status).toBe(404);
    expect(outside).toEqual(missing);
    const noRead = x.restricted((request) => request.action !== 'tenant.employment.read');
    expect((await inFlight(x, noRead)).status).toBe(403);
  });

  it('单据内容按字段权裁剪，与退休详情同一结果', async () => {
    const x = await world('trim');
    const draft = await draftOf(x);
    const fields = ['id', 'employeeId', 'kind', 'status', 'revision'];
    const limited = x.restricted(denyButtons(), undefined, fields);
    const shown = await item(x, limited);
    const detail = await (await limited('GET', `/retirements/${draft.id}`)).json();
    expect(shown).toEqual(detail);
    expect(shown).not.toHaveProperty('lastWorkDate');
  });
});
