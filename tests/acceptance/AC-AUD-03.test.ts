/**
 * AC-AUD-03（docs/02_业务建模/20 §3、§5 第 3 条；REQ-AUD-001 R3）：批量编辑 52 条任职记录，
 * 对象操作日志记一条「批量编辑 / 52条全部更新成功」（原站已证）；每条记录另有字段级数据变更日志（DEC-019）。
 * 批量写入整体成功或整体失败（AGENTS.md §10「批量」）：任一条失败则整单回滚，不留操作日志，只留失败命令审计。
 * 导入 / 错误报告下载同样留任务级日志。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession, EMP_TODAY, type EmploymentBusiness } from './AC-EMP-support.js';
import { auditApi, SOURCE_HEADERS } from './AC-AUD-support.js';

const testDb = useTestDb();
const NOW = `${EMP_TODAY}T01:00:00.000Z`;

async function batchWorld(label: string, count: number) {
  const { db } = testDb();
  const session = await employmentSession(db, label);
  const department = await session.org('批量编辑部门', { establishedOn: '2026-01-01' });
  const hires: EmploymentBusiness[] = [];
  for (let index = 0; index < count; index += 1) {
    const employee = await session.employee(`批量员工${index + 1}`);
    hires.push(
      await session.business(
        employee.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: department.id } },
        employee.revision,
      ),
    );
  }
  const as = { user: session.user.id, tenant: session.tenant.id };
  return { db, session, hires, as, audit: auditApi(db, NOW) };
}

describe('AC-AUD-03 批量编辑任职记录：对象操作日志', () => {
  it('批量编辑 52 条任职记录：一条「批量编辑 / 52条全部更新成功」，每条记录各有字段级日志', async () => {
    const w = await batchWorld('aud03-batch', 52);
    const response = await w.session.request('POST', '/records/batch-edit', {
      body: {
        items: w.hires.map((hire) => ({ id: hire.id, revision: hire.revision })),
        patch: { fields: { place: '批量新地点' } },
      },
      headers: SOURCE_HEADERS,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ total: 52, succeeded: 52, failed: 0 });

    const logs = await w.audit.operationLogs(w.as, { objectType: 'employment-record' });
    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]).toMatchObject({
      behavior: 'batch_update',
      behaviorLabel: '批量编辑',
      objectLabel: '任职记录',
      summary: '52条全部更新成功',
      totalCount: 52,
      successCount: 52,
      failureCount: 0,
      result: 'succeeded',
      operator: { userId: w.session.user.id },
      ip: '203.0.113.7',
      terminal: SOURCE_HEADERS['user-agent'],
    });

    const changes = await w.audit.dataChanges(w.as, { objectType: 'employment-record', field: 'place', limit: '100' });
    expect(changes.items).toHaveLength(52);
    expect(new Set(changes.items.map((item) => item.objectId))).toEqual(new Set(w.hires.map((hire) => hire.id)));
    expect(changes.items.every((item) => item.sourceAction === '编辑')).toBe(true);
  });

  it('任一条 revision 过期则整单回滚：无操作日志、无数据变更日志，失败命令记为业务失败', async () => {
    const w = await batchWorld('aud03-rollback', 3);
    const commandId = 'aud03-stale-batch';
    const response = await w.session.request('POST', '/records/batch-edit', {
      idempotencyKey: commandId,
      body: {
        items: w.hires.map((hire, index) => ({
          id: hire.id,
          revision: index === 2 ? hire.revision + 5 : hire.revision,
        })),
        patch: { fields: { place: '不应写入' } },
      },
    });
    expect(response.status).toBe(409);
    expect((await w.audit.operationLogs(w.as, { objectType: 'employment-record' })).items).toEqual([]);
    expect((await w.audit.dataChanges(w.as, { objectType: 'employment-record', field: 'place' })).items).toEqual([]);
    const failures = await w.audit.commandFailures(w.as, { commandId });
    expect(failures.items).toEqual([
      expect.objectContaining({
        outcome: 'business_failed',
        outcomeLabel: '业务失败',
        errorCode: 'REVISION_CONFLICT',
        method: 'POST',
        path: '/api/tenant/employment/records/batch-edit',
      }),
    ]);
  });

  it('批量条数设上限：超过 100 条直接拒绝', async () => {
    const w = await batchWorld('aud03-limit', 1);
    const items = Array.from({ length: 101 }, () => ({ id: w.hires[0]!.id, revision: w.hires[0]!.revision }));
    const response = await w.session.request('POST', '/records/batch-edit', {
      body: { items, patch: { fields: { place: '超限' } } },
    });
    expect(response.status).toBe(400);
  });

  it('同一条记录在一批里出现两次被拒绝（避免同单内自相覆盖）', async () => {
    const w = await batchWorld('aud03-duplicate', 1);
    const item = { id: w.hires[0]!.id, revision: w.hires[0]!.revision };
    const response = await w.session.request('POST', '/records/batch-edit', {
      body: { items: [item, item], patch: { fields: { place: '重复' } } },
    });
    expect(response.status).toBe(400);
  });
});
