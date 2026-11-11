/**
 * F-517（DEC-879①，复刻取舍，偏离北森原站：北森直接转正，证据 F500_09～11）：
 * “直接自动转正”类规则（direct）命中后，夜间跑批不直接转正，改为自动发起转正流程（走申请类同一入口与审批链），
 * 审批通过后才转正；条件不满足（未到期、已有转正记录等）不发起。application 类行为不变。
 * 规格：docs/02_业务建模/29 PB-R18 / PB-R21、AC-PB-08、AC-PB-15。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { draftRegularization, hire, pbWorld, probationOf, transition, type PbWorld } from './AC-PB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const SWITCH = 'probation.auto_regularization_enabled';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface RunReceipt {
  readonly launched: { employeeId: string; ruleId: string; businessId: string; businessStatus: string }[];
  readonly failed: { employeeId: string; ruleId: string; reason: string }[];
}

async function world(label: string) {
  const w = await pbWorld(testDb().db, `f517-${label}`, { approval: true });
  const settings = tenantApi(w.db);
  const as = { tenant: w.session.tenant.id, user: w.session.user.id };
  const rule = async (mode: 'direct' | 'application') => {
    const response = await w.session.request('POST', '/auto-regularization-rules', {
      ifMatch: 0,
      body: {
        name: `F-517 ${mode}`,
        priority: 1,
        orgIds: [w.org.id],
        includeSubordinates: true,
        mode,
        daysBefore: 0,
        initiatorType: 'rule_operator',
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const enableSwitch = async () => {
    const current = await settings.request('GET', `/api/tenant/settings/${SWITCH}`, as);
    const { revision } = (await current.json()) as { revision: number };
    const put = await settings.request('PUT', `/api/tenant/settings/${SWITCH}`, {
      ...as,
      ifMatch: revision,
      body: { value: true },
    });
    expect(put.status, await put.clone().text()).toBe(200);
  };
  const run = async (): Promise<RunReceipt> => {
    const response = await w.session.request('POST', '/auto-regularization/run', { ifMatch: 0, body: {} });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as RunReceipt;
  };
  return { ...w, rule, enableSwitch, run };
}

async function regularizations(w: PbWorld, employeeId: string) {
  return withTenant(w.db, w.session.tenant.id, async (tx) =>
    rows<{ id: string; state: string; effective_date: string; mode: string }>(
      await tx.execute(sql`SELECT b.id, s.state, p.effective_date::text AS effective_date, p.mode
        FROM employment_business_objects b
        JOIN LATERAL (SELECT * FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
          AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
        JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
          AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
        WHERE b.tenant_id=${w.session.tenant.id} AND b.employee_id=${employeeId}::uuid
          AND p.kind='regularization' ORDER BY b.id`),
    ),
  );
}

describe('AC-PB-15 直接自动转正类规则改为自动发起转正流程（F-517，DEC-879①）', () => {
  it('跑批后生成转正流程（审批中），员工仍为试用；审批通过后才转正，转正日 = 预计结束日次日', async () => {
    const w = await world('flow');
    const rule = await w.rule('direct');
    // 试用期 09-01～09-30：目标日 ≤ 跑批日 10-01，转正日 10-01
    const due = await hire(w, { date: '2026-09-01', months: 1 });
    await w.enableSwitch();
    const receipt = await w.run();
    expect(receipt.failed).toEqual([]);
    expect(receipt.launched).toEqual([
      expect.objectContaining({ employeeId: due.employee.id, ruleId: rule.id, businessStatus: 'in_review' }),
    ]);
    const [business] = await regularizations(w, due.employee.id);
    expect(business).toMatchObject({ state: 'in_review', mode: 'application', effective_date: '2026-10-01' });
    // 审批前仍是试用：没有转正日，任职记录里没有转正记录
    const before = await probationOf(w, due.employee.id, '2026-10-01');
    expect(before.regularizationDate).toBeNull();
    expect(before.records.some((record) => record.kind === 'regularization')).toBe(false);

    expect((await transition(w, business!, 'approve')).status).toBe(200);
    await transition(w, business!, 'activate');
    const after = await probationOf(w, due.employee.id, '2026-10-01');
    expect(after.regularizationDate).toBe('2026-10-01');
    expect(after.records.some((record) => record.kind === 'regularization')).toBe(true);
  });

  it('条件不满足不发起：未到期的人不发起；本周期已有转正记录的人失败且不新建流程', async () => {
    const w = await world('negatives');
    await w.rule('direct');
    const notDue = await hire(w, { date: '2026-09-01', months: 3, name: '未到期员工' });
    const hasRecord = await hire(w, { date: '2026-09-01', months: 1, name: '已有转正申请员工' });
    const draft = await draftRegularization(w, hasRecord.employee.id, '2026-10-01');
    expect((await transition(w, draft, 'submit')).status).toBe(200);
    await w.enableSwitch();
    const receipt = await w.run();
    expect(receipt.launched).toEqual([]);
    expect(receipt.failed).toEqual([
      expect.objectContaining({ employeeId: hasRecord.employee.id, reason: 'REGULARIZATION_EXISTS' }),
    ]);
    expect(await regularizations(w, notDue.employee.id)).toEqual([]);
    expect(await regularizations(w, hasRecord.employee.id)).toHaveLength(1);
  });
});
