import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';

const testDb = useTestDb();
describe('R2-T06 合同验收 AC-CT-01～10', () => {
  it('AC-CT-01 续签不能改类型，旧 revision 返回 409', async () => {
    const w = await contractWorld(testDb().db, 'ct01');
    const original = await w.create();
    expect((await w.change(original, 'renew', { typeId: w.otherType.id })).status).toBe(400);
    const terminated = await w.change(original, 'terminate', { actualTerminationDate: '2026-09-30' });
    expect(terminated.status).toBe(201);
    expect((await w.change(original, 'renew', { effectiveDate: '2026-10-01', endDate: '2027-09-30' })).status).toBe(409);
  });

  it.each([
    ['AC-CT-05', '2024-12-01', 'void', true],
    ['AC-CT-06', '2025-02-01', 'terminated', false],
  ])('%s 变更追加版本并保留前合同关联与编号规则', async (_ac, effectiveDate, status, sameNumber) => {
    const w = await contractWorld(testDb().db, `ct${status}`);
    const original = await w.create();
    const response = await w.change(original, 'change', { effectiveDate });
    expect(response.status, await response.clone().text()).toBe(201);
    const changed = await response.json() as ContractView;
    expect(changed.previousContractId).toBe(original.id);
    expect(changed.endDate).toBe(original.endDate);
    expect(changed.number === original.number).toBe(sameNumber);
    expect((await w.list()).find(c => c.id === original.id)?.status).toBe(status);
  });

  it('AC-CT-07/08 离职端口删除未来劳动合同，保留允许离职后签订的类型', async () => {
    const w = await contractWorld(testDb().db, 'ct0708');
    await w.settings({ postExitTypeIds: [w.otherType.id] });
    const future = await w.create({ effectiveDate: '2026-10-01', endDate: '2027-09-30' });
    const retained = await w.create({ typeId: w.otherType.id, effectiveDate: '2026-10-01', endDate: '2027-09-30' });
    const { handleContractsOnExit } = await import('../../apps/api/src/modules/contracts/ports.js');
    await withTenant(w.db, w.session.tenant.id, tx => handleContractsOnExit(tx, {
      tenantId: w.session.tenant.id, userId: w.session.user.id, timezone: 'Asia/Shanghai',
      now: new Date('2026-10-01T01:00:00Z'), commandId: randomUUID(), expectedRevision: 0,
    }, { employeeId: w.employee.id, lastWorkDate: '2026-09-30' }));
    expect((await w.list()).some(c => c.id === future.id)).toBe(false);
    expect((await w.list()).some(c => c.id === retained.id)).toBe(true);
    const audit = await withTenant(w.db, w.session.tenant.id, tx => tx.execute(
      sql`SELECT before FROM audit_events WHERE object_id=${future.id} AND action='contract.delete'`,
    ));
    expect(JSON.stringify(audit)).toContain(future.number);
  });

  it('AC-CT-09 初始化整批校验后删除重建，失败不删除原合同', async () => {
    const w = await contractWorld(testDb().db, 'ct09');
    const original = await w.create();
    const bad = await w.request('POST', '/imports', { ifMatch: 0, body: {
      mode: 'initialize', rows: [{ employeeId: w.employee.id, fields: { ...w.fields, endDate: '2024-01-01' } }],
      revisions: { [w.employee.id]: 1 },
    } });
    expect(bad.status).toBe(400);
    expect((await w.list())[0]?.id).toBe(original.id);
    const imported = await w.request('POST', '/imports', { ifMatch: 0, body: {
      mode: 'initialize', rows: [{ employeeId: w.employee.id, fields: { ...w.fields, number: 'IMPORTED' } }],
      revisions: { [w.employee.id]: 1 },
    } });
    expect(imported.status, await imported.clone().text()).toBe(200);
    expect((await w.list()).map(c => c.number)).toEqual(['IMPORTED']);
  });

  it('AC-CT-10 连续的不同类型合同按续签设置判定', async () => {
    const w = await contractWorld(testDb().db, 'ct10');
    const first = await w.create();
    await w.create({ typeId: w.otherType.id, effectiveDate: '2026-10-01', endDate: '2027-09-30' });
    expect((await w.list('expired_unrenewed')).some(c => c.id === first.id)).toBe(true);
    await w.settings({ renewalTypeIds: [w.type.id, w.otherType.id] });
    expect((await w.list('expired_unrenewed')).some(c => c.id === first.id)).toBe(false);
  });

  it('AC-CT-02/03/04 自动续签只取最晚合同、整人最高优先级、第三次无固定期限', async () => {
    const { automaticRenewalPlans } = await import('../../packages/domain/src/contracts/rules.js');
    const rows = [
      { id: 'old', employeeId: 'p', typeId: 'labor', endDate: '2026-08-31', status: 'valid',
        approvalStatus: 'effective', actualTerminationDate: null, signingCount: 1 },
      { id: 'latest', employeeId: 'p', typeId: 'labor', endDate: '2026-10-01', status: 'valid',
        approvalStatus: 'effective', actualTerminationDate: null, signingCount: 2 },
      { id: 'other', employeeId: 'p', typeId: 'other', endDate: '2026-10-01', status: 'valid',
        approvalStatus: 'effective', actualTerminationDate: null, signingCount: 1 },
    ];
    const detail = { typeId: 'labor', months: 12, initiatorId: 'hr', daysBefore: 10, skipTypeIds: [] };
    const rules = [
      { id: 'low', priority: 2, orgIds: ['dept'], personIds: [], details: [{ ...detail, typeId: 'other' }] },
      { id: 'high', priority: 1, orgIds: ['dept'], personIds: [], details: [detail] },
    ];
    const plans = automaticRenewalPlans(rows, rules, 'p', 'dept', '2026-09-25');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ targetId: 'latest', termType: 'indefinite', endDate: null, signingCount: 3 });
  });
});
