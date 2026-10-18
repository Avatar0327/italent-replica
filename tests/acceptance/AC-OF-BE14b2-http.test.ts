/**
 * BE-14b2 行为红测（审查 P3）：只经现有 HTTP 入口——管理员转已接受后，出厂设置下应出现待入职。
 * 本文件不 import 任何 b2 新增模块，在 b2 之前的代码上能收集、能执行，并因断言失败判红。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { syncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();

describe('AC-OF-10 经 HTTP 入口：接受 Offer 后出现待入职', () => {
  it('出厂设置：转已接受 → Offer 关联待入职，待入职列表出现该人员，部门 / 计划入职日带入', async () => {
    const w = await syncWorld(testDb().db, 'http-accept');
    const accepted = await w.accepted(await w.social());
    const detail = await w.read(accepted.id);
    expect(detail.hasPendingEntry).toBe(true);
    const items = await w.entries();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ departmentId: w.department.id, effectiveDate: '2026-11-01', employeeStatus: 1 });
  });
});
