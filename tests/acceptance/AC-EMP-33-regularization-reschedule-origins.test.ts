/**
 * AC-EMP-33 转正改期后的字段来源（F-036-S6 合 main 返工第 1 轮 P2-1，设计 §4.4.2 #14）：
 * 改期重算继承字段时追加的新 inherit 行必须取代旧前驱留下的 resolved——字段值、来源、pending 三项同口径。
 * 真实 HTTP：先办 11-15 调动（填工作地）、再办 12-01 转正（ungrouped-custom），然后 POST /businesses/:id/regularization-date。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { saveTransferForm } from '../../apps/api/src/modules/transfer/configuration.js';
import { employeeRevision, hire, pbWorld, rescheduleRegularization, type PbWorld } from './AC-PB-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

interface OriginRow {
  fieldCode: string;
  value: unknown;
  policy: string | null;
  pending: boolean;
  origin: { kind: string; sourceBusinessId: string | null } | null;
}

async function world(label: string) {
  const w = await pbWorld(database().db, `emp33-${label}-${uniqueSuffix()}`);
  await withTenant(w.db, w.session.tenant.id, (tx) =>
    saveTransferForm(
      tx,
      {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: w.session.tenant.timezone,
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: 0,
      },
      { id: 'ungrouped-custom', name: '合成未分组表单', group: null, fieldModes: {} },
    ),
  );
  const { employee } = await hire(w, { months: 3 });
  const transfer = await w.session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-15', fields: { place: '调动地点' } },
    await employeeRevision(w, employee.id),
  );
  const regularization = await w.session.business(
    employee.id,
    { kind: 'regularization', mode: 'direct', effectiveDate: '2026-12-01', formId: 'ungrouped-custom' },
    await employeeRevision(w, employee.id),
  );
  w.session.setNow('2026-12-05T02:00:00Z');
  return { w, employee, transfer, regularization };
}

async function placeOrigin(w: PbWorld, businessId: string): Promise<OriginRow> {
  const response = await w.session.request('GET', `/businesses/${businessId}/field-origins`);
  expect(response.status, await response.clone().text()).toBe(200);
  const rows = ((await response.json()) as { fields: OriginRow[] }).fields;
  return rows.find((row) => row.fieldCode === 'preset:place')!;
}

async function placeValue(w: PbWorld, businessId: string, asOf: string) {
  // 任职业务的记录快照与业务同 ID
  return (await w.session.record(businessId, asOf)).fields.place ?? null;
}

describe('AC-EMP-33 转正改期后的工作地来源', () => {
  it('前提：改期前，工作地沿用 11-15 调动，来源为该调动落地时的 resolved', async () => {
    const { w, transfer, regularization } = await world('before');
    expect(await placeOrigin(w, regularization.id)).toMatchObject({
      value: '调动地点',
      policy: 'deferred',
      pending: false,
      origin: { kind: 'resolved', sourceBusinessId: transfer.id },
    });
  });

  it('提前到 11-01（跨过 11-15 调动）：工作地按新前驱重算为空，来源是本次重算的 inherit，不再指向旧调动', async () => {
    const { w, transfer, regularization } = await world('earlier');
    const response = await rescheduleRegularization(w, regularization.id, '2026-11-01');
    expect(response.status, await response.clone().text()).toBe(200);
    const place = await placeOrigin(w, regularization.id);
    expect(place.value).toBeNull();
    expect(place).toMatchObject({ policy: 'inherit', pending: false, origin: { kind: 'inherit' } });
    expect(place.origin?.sourceBusinessId).not.toBe(transfer.id);
    expect(await placeValue(w, regularization.id, '2026-12-05')).toBeNull();
  });

  it('推后到 12-10（未来）：工作地仍取 11-15 调动，来源是本次重算的 inherit，不为空', async () => {
    const { w, regularization } = await world('later');
    const response = await rescheduleRegularization(w, regularization.id, '2026-12-10');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await placeOrigin(w, regularization.id)).toMatchObject({
      value: '调动地点',
      policy: 'inherit',
      pending: false,
      origin: { kind: 'inherit' },
    });
    expect(await placeValue(w, regularization.id, '2026-12-10')).toBe('调动地点');
  });
});
