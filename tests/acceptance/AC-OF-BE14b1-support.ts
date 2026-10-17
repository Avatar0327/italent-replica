/**
 * BE-14b1 验收夹具：发送记录读取、编制（控编方案 + 容量）造数、OF-R3 / OF-R4 两项配置覆盖。
 * 建立在 BE-14a 的 offerWorld 之上（租户、录用部门、社招必填引用）。
 */
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import type { OfferBody, OfferWorld } from './AC-OF-BE14a-support.js';

export const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export interface SendRecordRow {
  readonly kind: string;
  readonly status: string;
  readonly recipient: string;
  readonly cc: string[];
  readonly bcc: string[];
}

/** 一份 Offer 的发送记录（邮件 outbox，首版只记一行 pending），按发送先后。 */
export async function sendRecords(w: OfferWorld, offerId: string): Promise<SendRecordRow[]> {
  return rowsOf<SendRecordRow>(
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`SELECT kind, status, recipient, cc, bcc FROM offer_send_records
        WHERE offer_id = ${offerId} ORDER BY created_at, id`),
    ),
  );
}

export const send = (
  w: Pick<OfferWorld, 'request'>,
  offer: Pick<OfferBody, 'id' | 'revision'>,
  body: Record<string, unknown> = {},
  options: { idempotencyKey?: string } = {},
) => w.request('POST', `/${offer.id}/send`, { ifMatch: offer.revision, body, ...options });

/** 经现有配置接口覆盖 Offer 的配置（OF-R3 发送前须审批 / OF-R4 必审字段）。 */
export async function overrideSetting(w: OfferWorld, key: string, value: unknown, ifMatch = 0) {
  return w.seeder.request('PUT', `/api/tenant/settings/${key}`, {
    user: w.user.id,
    tenant: w.tenant.id,
    ifMatch,
    body: { value },
  });
}

export const requireApproval = (w: OfferWorld, social = true) =>
  overrideSetting(w, 'offer.send_requires_approval', { social, campus: false, intern: false });

/** 录用部门的编制：占编条件 = 内部员工；localCapacity 为 0 时任何新增一人都超编。 */
export async function setEstablishment(w: OfferWorld, strictControl: boolean, localCapacity: number) {
  const as = { user: w.user.id, tenant: w.tenant.id, ifMatch: 0 };
  const post = (path: string, body: object) =>
    w.seeder.request('POST', `/api/tenant/establishment${path}`, { ...as, body });
  const scheme = await post('/schemes', {
    name: '合成 Offer 控编方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges: [{ employmentType: 'internal' }],
  });
  expect(scheme.status, await scheme.clone().text()).toBe(201);
  const { id: schemeId } = (await scheme.json()) as { id: string };
  const capacity = await post('/capacities', {
    orgId: w.department.id,
    schemeId,
    periodStart: '2026-01-01',
    localCapacity,
    strictControl,
  });
  expect(capacity.status, await capacity.clone().text()).toBe(201);
}
