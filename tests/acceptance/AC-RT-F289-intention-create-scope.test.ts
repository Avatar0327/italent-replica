/**
 * F-289（#456 R2 转 F）：意向退休申请创建入口先判本单范围、再比 If-Match revision。
 * 旧写法先比 revision：范围外 HR 带错 revision 得 409 REVISION_CONFLICT，details.actual 回显员工当前 revision（泄露存在性与版本）。
 * 现在范围外无论 revision 对错一律 404「意向退休申请不存在」且响应不含 revision；范围内带错 revision 仍是 409。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { realUser } from './AC-RT-intention-real-support.js';
import { intentionWorld } from './AC-RT-intention-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => intentionWorld(database().db, `f289-${label}-${uniqueSuffix()}`);

describe('AC-RT-F289 创建入口范围先于 revision', () => {
  it('范围外 HR（只管部门 A，员工在 B）带正确 / 错误 revision 均 404，响应不含 revision；范围内错 revision 仍 409', async () => {
    const w = await world('create');
    const outside = await realUser(w, '范围外HR', { orgIds: [w.deptA] });
    const inside = await realUser(w, '范围内HR', { orgIds: [w.deptB] });
    const current = await w.revisionOf();
    const create = (user: typeof outside, ifMatch: number) =>
      user.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
        ifMatch,
        body: { intendedDate: '2030-03-01' },
      });

    for (const ifMatch of [current, current + 7]) {
      const response = await create(outside, ifMatch);
      const text = await response.text();
      expect(response.status, text).toBe(404);
      expect(text).not.toContain('REVISION_CONFLICT');
      expect(text).not.toContain('actual');
      expect(text).not.toContain(String(current + 7));
    }

    const stale = await create(inside, current + 7);
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    expect((await w.list()).total).toBe(0);
  });
});
