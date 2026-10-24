/** F-317：列表首次发起交接；合成数据、普通角色、逐项事务与原批次恢复。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_GRANT_CODES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { handoverWorld, type HandoverWorld } from './AC-EXIT-handover-support.js';
import { isButton, revocable } from './support/revocable-rights.js';

const database = useTestDb();
const DETAIL = 'EmploymentRecrdDetailDimissionHandoverApproval';
const ROW = 'EmploymentRecrdLineOpDimissionHandoverApproval';
const BATCH = 'BatchDimissionHandoverApproval';
const batchPath = '/exits/handover/batch-submit';
const rowPath = (id: string) => `/exits/${id}/handover/submit-from-list`;
const detailPath = (id: string) => `/exits/${id}/handover/submit`;
const one = (revision: number) => ({ ifMatch: revision, body: {}, idempotencyKey: randomUUID() });
const batch = (exits: readonly { id: string; revision: number }[]) => ({
  body: { items: exits.map((exit) => ({ exitRequestId: exit.id, revision: exit.revision })) },
  idempotencyKey: randomUUID(),
});
async function world(label: string) {
  const x = await handoverWorld(database().db, `f317-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  return x;
}
async function exit(x: HandoverWorld, mode: 'application' | 'direct' = 'direct') {
  const employee = await x.colleague('批量交接合成员工');
  await x.applicantAccount(employee.id);
  return x.createdExit(employee.id, '2026-10-21', mode, {
    exitTypeCode: 'voluntary',
    handoverEmployeeId: x.workOwner.employeeId,
  });
}
async function receipts(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    items: { exitRequestId: string; outcome: string; reason?: string; requestId?: string }[];
  };
}

describe('AC-DM-09 / F-317 列表行与批量首次发起离职交接', () => {
  it('原站完整按钮编码 / 名称 / 位置，仅预置 HR 三身份', () => {
    for (const [code, name, level] of [
      [ROW, '发起离职交接', 'list_row'],
      [BATCH, '批量发起离职交接', 'list'],
    ]) {
      expect(MODULE_OBJECTS.employmentRecord.buttons.find((b) => b.code === code)).toEqual({
        code,
        name,
        level,
        requires: 'update',
      });
      const suffix = `/TenantBase.EmploymentRecord/button:${code}@${level}`;
      expect(STANDARD_GRANT_CODES.filter((c) => c.endsWith(suffix)).sort()).toEqual(
        ['standard_hr_admin', 'standard_hr_specialist', 'standard_org_system_admin'].map((c) => c + suffix),
      );
    }
  });
  it('3 项混合：成功 / 已有 / 范围外独立回执，重放不重复创建，成功逐项审计记 HR', async () => {
    const x = await world('mixed');
    const a = await exit(x);
    const b = await exit(x);
    const c = await exit(x);
    expect((await x.session.request('POST', detailPath(b.id), one(b.revision))).status).toBe(200);
    const hiddenEmployee = (await x.business(c.id)).employeeId;
    const { rights, authorize } = revocable();
    rights.deny = (request) => request.action === 'tenant.employment.write' && request.resource === hiddenEmployee;
    const request = x.asUser(x.session.user.id, authorize);
    const init = batch([a, b, c]);
    const result = await receipts(await request('POST', batchPath, init));
    expect(result.items).toEqual([
      expect.objectContaining({ exitRequestId: a.id, outcome: 'launched' }),
      expect.objectContaining({ exitRequestId: b.id, outcome: 'failed', reason: 'EXIT_HANDOVER_EXISTS' }),
      expect.objectContaining({ exitRequestId: c.id, outcome: 'failed', reason: 'FORBIDDEN' }),
    ]);
    expect(await receipts(await request('POST', batchPath, init))).toEqual(result);
    expect(await x.requestRows(a.id)).toHaveLength(1);
    expect(await x.requestRows(b.id)).toHaveLength(1);
    expect(await x.requestRows(c.id)).toHaveLength(0);
    const audit = await x.sqlRows<{ actor: string; id: string }>(sql`SELECT actor_user_id AS actor, object_id AS id
      FROM audit_events WHERE tenant_id=${x.tenantId} AND action='exit_handover.launch' ORDER BY object_id`);
    expect(audit).toHaveLength(2);
    expect(audit.every((item) => item.actor === x.session.user.id)).toBe(true);
    expect(audit.map((item) => item.id)).toContain(result.items[0]!.requestId);
  });
  it('列表行单人发起成功，同行重放幂等，撤销行按钮后首次与重放均拒绝', async () => {
    const x = await world('row');
    const a = await exit(x);
    const { rights, authorize } = revocable();
    const request = x.asUser(x.session.user.id, authorize);
    const init = one(a.revision);
    rights.deny = isButton(ROW);
    expect((await request('POST', rowPath(a.id), init)).status).toBe(403);
    expect(await x.requestRows(a.id)).toEqual([]);
    rights.deny = undefined;
    const first = await request('POST', rowPath(a.id), init);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await (await request('POST', rowPath(a.id), init)).json()).toEqual(await first.json());
    rights.deny = isButton(ROW);
    expect((await request('POST', rowPath(a.id), init)).status).toBe(403);
    expect(await x.requestRows(a.id)).toHaveLength(1);
  });
  it.each([DETAIL, ROW, BATCH])('只有 %s 时，另两个编码不能替代授权', async (held) => {
    const x = await world(`separate-${held}`);
    const { rights, authorize } = revocable();
    rights.deny = (request) => [DETAIL, ROW, BATCH].filter((b) => b !== held).some((b) => isButton(b)(request));
    const request = x.asUser(x.session.user.id, authorize);
    for (const code of [DETAIL, ROW, BATCH]) {
      const a = await exit(x);
      const response =
        code === BATCH
          ? await request('POST', batchPath, batch([a]))
          : await request('POST', code === ROW ? rowPath(a.id) : detailPath(a.id), one(a.revision));
      expect(response.status, await response.clone().text()).toBe(code === held ? 200 : 403);
      expect(await x.requestRows(a.id)).toHaveLength(code === held ? 1 : 0);
    }
  });
  it('revision 冲突 / 草稿状态 / 不存在项不会回滚相邻成功项，失败项无交接与成功审计', async () => {
    const x = await world('failures');
    const a = await exit(x);
    const b = await exit(x);
    const c = await exit(x, 'application');
    const missing = { id: randomUUID(), revision: 1 };
    const init = batch([a, { ...b, revision: b.revision + 1 }, c, missing]);
    const result = await receipts(await x.session.request('POST', batchPath, init));
    expect(result.items.map((r) => [r.outcome, r.reason])).toEqual([
      ['launched', undefined],
      ['failed', 'REVISION_CONFLICT'],
      ['failed', 'EXIT_HANDOVER_NOT_SUBMITTABLE'],
      ['failed', 'NOT_FOUND'],
    ]);
    expect(await x.requestRows(a.id)).toHaveLength(1);
    expect(await x.requestRows(b.id)).toEqual([]);
    expect(await x.requestRows(c.id)).toEqual([]);
    expect(await x.auditActions((await x.requestRows(a.id))[0]!.id, 'exit_handover.launch')).toHaveLength(1);
    expect(await receipts(await x.session.request('POST', batchPath, init))).toEqual(result);
  });
  it('整批同键异内容拒绝；丢失汇总后按子项恢复不重复，预登记阻止变更批次先写新项', async () => {
    const x = await world('recovery');
    const a = await exit(x);
    const b = await exit(x);
    const init = batch([a]);
    const result = await receipts(await x.session.request('POST', batchPath, init));
    // 模拟所有子项已提交、汇总命令尚未落库的恢复点；仅删测试租户自己的汇总台账。
    await withTenant(x.db, x.tenantId, (tx) =>
      tx.execute(sql`DELETE FROM command_ledger
      WHERE tenant_id=${x.tenantId} AND command_id=${init.idempotencyKey}`),
    );
    const changed = await x.session.request('POST', batchPath, {
      ...batch([b, a]),
      idempotencyKey: init.idempotencyKey,
    });
    expect(changed.status).toBe(409);
    expect(await x.requestRows(b.id)).toEqual([]);
    expect(await receipts(await x.session.request('POST', batchPath, init))).toEqual(result);
    expect(await x.requestRows(a.id)).toHaveLength(1);
  });
  it('撤销批量按钮拒绝回放；撤范围后逐项隐去旧成功回执，跨租户 ID 无法发起', async () => {
    const x = await world('replay-rights');
    const a = await exit(x);
    const { rights, authorize } = revocable();
    const request = x.asUser(x.session.user.id, authorize);
    const init = batch([a]);
    await receipts(await request('POST', batchPath, init));
    rights.deny = isButton(BATCH);
    expect((await request('POST', batchPath, init)).status).toBe(403);
    rights.deny = undefined;
    rights.emptyScope = true;
    const hidden = await receipts(await request('POST', batchPath, init));
    expect(hidden.items).toEqual([{ exitRequestId: a.id, outcome: 'failed', reason: 'NOT_FOUND' }]);
    const y = await world('other-tenant');
    const other = await exit(y);
    expect((await y.session.request('POST', rowPath(a.id), one(a.revision))).status).toBe(404);
    const cross = await receipts(await y.session.request('POST', batchPath, batch([a, other])));
    expect(cross.items[0]).toEqual({ exitRequestId: a.id, outcome: 'failed', reason: 'NOT_FOUND' });
    expect(cross.items[1]?.outcome).toBe('launched');
    expect(await x.requestRows(a.id)).toHaveLength(1);
  });
  it('批量输入：缺键 / 空选择 / 超过 100 / UUID 大小写重复 / revision 缺失均无写入', async () => {
    const x = await world('input');
    const a = await exit(x);
    const item = { exitRequestId: a.id, revision: a.revision };
    for (const items of [
      [],
      Array.from({ length: 101 }, () => item),
      [item, { ...item, exitRequestId: a.id.toUpperCase() }],
      [{ exitRequestId: a.id }],
    ]) {
      expect((await x.session.request('POST', batchPath, { body: { items } })).status).toBe(400);
    }
    const response = await x.session.request('POST', batchPath, {
      body: { items: [item] },
      idempotencyKey: '',
    });
    expect(response.status).toBe(400);
    expect(await x.requestRows(a.id)).toEqual([]);
  });
  it('rowActions 只在列表行按钮、写范围、首次发起状态均满足时出现', async () => {
    const x = await world('actions');
    const a = await exit(x);
    const b = await exit(x, 'application');
    const c = await exit(x);
    expect((await x.session.request('POST', detailPath(c.id), one(c.revision))).status).toBe(200);
    const { rights, authorize } = revocable();
    const request = x.asUser(x.session.user.id, authorize);
    const actions = async () => {
      const r = await request('GET', '/exits?view=all');
      expect(r.status).toBe(200);
      return ((await r.json()) as { items: { id: string; rowActions: string[] }[] }).items;
    };
    const items = await actions();
    expect(items.find((r) => r.id === a.id)?.rowActions).toEqual([ROW]);
    expect(items.find((r) => r.id === b.id)?.rowActions).toEqual([]);
    expect(items.find((r) => r.id === c.id)?.rowActions).toEqual([]);
    rights.deny = isButton(ROW);
    expect((await actions()).every((r) => r.rowActions.length === 0)).toBe(true);
    rights.deny = undefined;
    rights.emptyScope = true;
    expect((await actions()).every((r) => r.rowActions.length === 0)).toBe(true);
  });
});
