/**
 * BE-14b1 验收夹具：发送记录读取、编制（控编方案 + 容量）造数、OF-R3 / OF-R4 两项配置覆盖。
 * 建立在 BE-14a 的 offerWorld 之上（租户、录用部门、社招必填引用）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import { withLoginEmail } from './AC-EMP-support.js';
import type { OfferBody, OfferRealWorld, OfferWorld } from './AC-OF-BE14a-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';

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

export interface LeaverKeys {
  readonly idNumber?: string;
  readonly mobilePhone?: string;
  readonly email?: string;
}

/** 已离职人员（入职 2026-01-15、最后工作日 2026-09-20），人员档案带证件 / 手机 / 邮箱；造数走全部允许的实例。 */
export async function leaver(w: OfferWorld, departmentId: string, keys: LeaverKeys, name = '离职合成员工') {
  const as = { user: w.user.id, tenant: w.tenant.id };
  const employmentApi = (method: string, path: string, options: object = {}) =>
    w.seeder.request(method, `/api/tenant/employment${path}`, { ...as, ...options });
  const created = await employmentApi('POST', '/employees', {
    ifMatch: 0,
    body: { name, code: `LV_${randomUUID().replaceAll('-', '')}` },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const { id, revision } = (await created.json()) as { id: string; revision: number };
  const business = (revisionNow: number, body: Record<string, unknown>) =>
    employmentApi('POST', `/employees/${id}/businesses`, { ifMatch: revisionNow, body: withLoginEmail(id, body) });
  const hired = await business(revision, {
    kind: 'hire',
    mode: 'direct',
    effectiveDate: '2026-01-15',
    fields: { employType: 'internal', departmentId },
  });
  expect(hired.status, await hired.clone().text()).toBe(201);
  const personnelPath = `/api/tenant/personnel/employees/${id}`;
  const profile = await w.seeder.request('GET', personnelPath, as);
  const patched = await w.seeder.request('PATCH', personnelPath, {
    ...as,
    ifMatch: ((await profile.json()) as { revision: number }).revision,
    body: keys.idNumber ? { idType: 'id_card', ...keys } : keys,
  });
  expect(patched.status, await patched.clone().text()).toBe(200);
  const current = await employmentApi('GET', `/employees/${id}`);
  const left = await business(((await current.json()) as { revision: number }).revision, {
    kind: 'leave',
    mode: 'direct',
    lastWorkDate: '2026-09-20',
    fields: {},
  });
  expect(left.status, await left.clone().text()).toBe(201);
  return { id };
}

/**
 * 给真实授权器下的成员单独授任职记录的查看权（独立身份，可整体撤销）：hide 是不给查看的字段。
 * 撤销只拿掉这一份授权，Offer 自己的权限不受影响（重放时重新授权的用例用）。
 */
export async function employmentViewer(w: OfferRealWorld, hide: readonly string[] = []) {
  const profile = await createProfile(w.seed, `emp-view-${randomUUID()}`);
  await makeGrantable(w.seed, [profile.id]);
  const definition = MODULE_OBJECTS.employmentRecord;
  const set = await setObjectPermission(
    w.seed,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hide.includes(f.code), edit: false })),
      buttons: [],
    },
    definition.code,
  );
  expect(set.status, await set.clone().text()).toBe(200);
  const granted = await grant(w.seed, w.member.id, profile.id);
  expect(granted.status, await granted.clone().text()).toBe(201);
  const { id, revision } = (await granted.json()) as { id: string; revision: number };
  return {
    revoke: async () => {
      const response = await w.seed.api.request('POST', `/api/tenant/permission/grants/${id}/revoke`, {
        ...w.seed.asAdmin,
        ifMatch: revision,
      });
      expect(response.status, await response.clone().text()).toBe(200);
    },
  };
}
