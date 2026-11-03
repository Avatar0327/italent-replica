/**
 * F-351 ④ / DEC-716：北森退休表单没有加黑字段——复刻去掉退休的手动加黑勾选。
 * 口径选“拒绝”而不是静默忽略：退休单任何入口（创建 exit 区块、PATCH、专用入口）带加黑字段，
 * 一律 400 RETIREMENT_FIELD_NOT_ALLOWED（与离职专用字段同一校验口径），不写单据也不写黑名单；
 * 离职的手动加黑不变（AC-EXIT-blacklist-*）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dedicatedBody, retireBody, retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const DUE = '2026-10-05';
const LATER = '2026-10-20';
const MANUAL = { addToBlacklist: true, blacklistReason: 'integrity', blacklistNote: '合成说明' };

async function world(label: string) {
  const x = await retirementWorld(database().db, `f351-bl-${label}`, TODAY);
  const blacklistRows = async () =>
    x.sqlRows(sql`SELECT 1 FROM employment_blacklist WHERE tenant_id=${x.session.tenant.id}`);
  return { ...x, blacklistRows };
}

describe('F-351 退休不收加黑字段（DEC-716）', () => {
  it.each([
    ['勾选加黑', MANUAL],
    ['只带 addToBlacklist=false', { addToBlacklist: false }],
    ['只带加黑原因', { blacklistReason: 'integrity' }],
  ])('创建：exit 区块带加黑字段（%s）→ 400 RETIREMENT_FIELD_NOT_ALLOWED，无任何写入', async (_name, exit) => {
    const x = await world('create');
    await x.setExpectedRetirement(DUE);
    const before = await x.stateOf(x.employee.id);
    for (const body of [retireBody(DUE, 'direct', exit), { ...dedicatedBody(DUE, 'direct', exit) }]) {
      const response =
        'kind' in body
          ? await x.createRetire(x.employee.id, body)
          : await x.session.request('POST', `/retirements/employees/${x.employee.id}`, {
              ifMatch: (await x.session.getEmployee(x.employee.id)).revision,
              body,
            });
      expect(await x.reason(response)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        reason: 'RETIREMENT_FIELD_NOT_ALLOWED',
      });
    }
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.blacklistRows()).toEqual([]);
  });

  it('编辑：PATCH retirements/:id 带加黑字段 → 400，单据不变', async () => {
    const x = await world('patch');
    const draft = await x.createdRetire(x.employee.id, retireBody(LATER));
    const { revision } = await x.business(draft.id);
    const before = await x.stateOf(x.employee.id);
    const response = await x.session.request('PATCH', `/retirements/${draft.id}`, {
      ifMatch: revision,
      body: MANUAL,
    });
    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'RETIREMENT_FIELD_NOT_ALLOWED' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect((await x.exitRow(draft.id))?.add_to_blacklist).toBe(false);
  });

  it('不带加黑字段的直接退休照常生效，且不写黑名单', async () => {
    const x = await world('plain');
    await x.setExpectedRetirement(DUE);
    const created = await x.createdRetire(x.employee.id, retireBody(DUE, 'direct'));
    expect(created.status).toBe('effective');
    expect(await x.blacklistRows()).toEqual([]);
  });
});
