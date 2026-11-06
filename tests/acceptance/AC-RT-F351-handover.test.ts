/**
 * F-351 ②：GET /exits/:id/handover 受理退休单（退休交接页签的读口径）。
 * 退休不发起交接（10-31 取证，DEC-714 同源）：退休单读到“未发起”且 request 为空；
 * 权限与范围同详情（DEC-177）——范围外、不存在同一个 404；离职单行为不变。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementWorld(database().db, label, TODAY);

describe('F-351 退休单的交接状态读取', () => {
  it('退休单（草稿 / 已批准）读到 not_started，request 为空', async () => {
    const x = await world('f351-ho-read');
    const approved = await x.directRetire('2026-10-25');
    const response = await x.session.request('GET', `/exits/${approved.id}/handover`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ status: 'not_started', request: null });
  });

  it('范围外与不存在同一个 404（同状态同文案）；没有任职记录查看权 403', async () => {
    const x = await world('f351-ho-scope');
    const retire = await x.directRetire('2026-10-25');
    const nobody = x.restricted(denyButtons(), '00000000-0000-4000-8000-000000000001');
    const outside = await nobody('GET', `/exits/${retire.id}/handover`);
    const missing = await nobody('GET', '/exits/00000000-0000-4000-8000-0000000000aa/handover');
    expect(outside.status).toBe(404);
    expect({ status: outside.status, body: await outside.text() }).toEqual({
      status: missing.status,
      body: await missing.text(),
    });
    const noRead = x.restricted((request) => request.action !== 'tenant.employment.read');
    expect((await noRead('GET', `/exits/${retire.id}/handover`)).status).toBe(403);
  });

  it('离职单不变：仍读到交接状态', async () => {
    const x = await world('f351-ho-leave');
    const leave = await x.directLeave('2026-10-25');
    const response = await x.session.request('GET', `/exits/${leave.id}/handover`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'not_started' });
  });
});
