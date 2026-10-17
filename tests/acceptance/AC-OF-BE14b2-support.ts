/**
 * BE-14b2 Offer 同步待入职验收夹具：在 BE-14a 夹具上加同步时机设置、立即同步、待入职读取、控编造数与在职实习生造数。
 */
import { expect } from 'vitest';
import { offerWorld, type OfferBody, type OfferWorld } from './AC-OF-BE14a-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import type { Db } from '@italent/db';

export const SYNC_SETTING = '/api/tenant/settings/offer.sync_timing';
export const ACCEPT = { target: 'accepted', acceptTime: '2026-10-17' };
export interface SyncOffer extends OfferBody {
  readonly syncStatus: string | null;
  readonly syncReason: string | null;
  readonly syncMessage: string | null;
  readonly syncAttempts: number;
  readonly hasPendingEntry: boolean;
  readonly pendingEntryBusinessId: string | null;
  readonly linkedEmployeeId: string | null;
  readonly syncedContractKind: string | null;
}

export interface EntryItem {
  readonly id: string;
  readonly employeeId: string;
  readonly name: string;
  readonly effectiveDate: string;
  readonly employeeStatus: number;
  readonly entryStatus: number | null;
  readonly departmentId: string | null;
  readonly probation: boolean | null;
  readonly contractStartDate: string | null;
  readonly contractEndDate: string | null;
}

export async function syncWorld(db: Db, label: string, world?: OfferWorld) {
  const w = world ?? (await offerWorld(db, label));
  const as = { user: w.user.id, tenant: w.tenant.id };
  let settingRevision = 0;
  /** 同步时机设置（OF-R8）：整份覆盖租户配置。 */
  async function timing(value: Record<string, unknown>) {
    const defaults = { enabled: true, mode: 'on_accept', days: 30, internConversion: true };
    const response = await w.seeder.request('PUT', SYNC_SETTING, {
      ...as,
      ifMatch: settingRevision,
      body: { value: { ...defaults, ...value } },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    settingRevision = ((await response.json()) as { revision: number }).revision;
  }
  const read = async (id: string) => (await w.get(id)) as SyncOffer;
  const sync = (offer: Pick<OfferBody, 'id' | 'revision'>, ifMatch = offer.revision) =>
    w.request('POST', `/${offer.id}/sync`, { ifMatch, body: {} });
  async function synced(offer: Pick<OfferBody, 'id' | 'revision'>): Promise<SyncOffer> {
    const response = await sync(offer);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as SyncOffer;
  }
  async function accepted(offer: Pick<OfferBody, 'id' | 'revision'>): Promise<SyncOffer> {
    return (await w.moved(offer, ACCEPT)) as SyncOffer;
  }
  const employment = (method: string, path: string, options: { ifMatch?: number; body?: unknown } = {}) =>
    w.seeder.request(method, `/api/tenant/employment${path}`, { ...as, ...options });
  async function entries(view = 'all'): Promise<EntryItem[]> {
    const response = await employment('GET', `/pending-entries?view=${view}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: EntryItem[] }).items;
  }
  async function entryOf(offer: SyncOffer): Promise<EntryItem> {
    const found = (await entries()).find((item) => item.id === offer.pendingEntryBusinessId);
    expect(found, '待入职列表里应有该 Offer 关联的记录').toBeDefined();
    return found!;
  }
  async function record(id: string) {
    const response = await employment('GET', `/records/${id}?asOf=2026-12-31`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { employeeId: string; fields: Record<string, unknown> };
  }
  async function businessRevision(id: string) {
    const response = await employment('GET', `/businesses/${id}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { revision: number }).revision;
  }
  /** 待入职动作（取消 / 改期），返回响应。 */
  const entryAction = async (id: string, action: 'cancel' | 'postpone', body: object) =>
    employment('POST', `/pending-entries/${id}/${action}`, { ifMatch: await businessRevision(id), body });
  /** 在职实习生：经任职接口办理直接入职（实习生）。 */
  async function internEmployee(name: string, employType: 'intern' | 'internal' = 'intern') {
    const created = await employment('POST', '/employees', {
      ifMatch: 0,
      body: { name, code: `INT_${crypto.randomUUID().replaceAll('-', '')}` },
    });
    expect(created.status).toBe(201);
    const employee = (await created.json()) as { id: string; revision: number };
    const hired = await employment('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: withLoginEmail(employee.id, {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-10-17',
        fields: { employType, departmentId: w.department.id },
      }),
    });
    expect(hired.status, await hired.clone().text()).toBe(201);
    return employee;
  }
  /** 严格控编：部门编制 1，已占 1（占编的是另一名内部员工）。 */
  async function strictCapacity() {
    const post = (path: string, body: object) =>
      w.seeder.request('POST', `/api/tenant/establishment${path}`, { ...as, ifMatch: 0, body });
    const scheme = await post('/schemes', {
      name: '合成同步控编方案',
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
      localCapacity: 1,
      strictControl: true,
    });
    expect(capacity.status, await capacity.clone().text()).toBe(201);
    await internEmployee('占编合成员工', 'internal');
    return (await capacity.json()) as { id: string; revision: number };
  }
  /** 放开严格控制，让失败的同步可以重试成功。 */
  async function relaxCapacity(capacity: { id: string; revision: number }) {
    const response = await w.seeder.request('PATCH', `/api/tenant/establishment/capacities/${capacity.id}`, {
      ...as,
      ifMatch: capacity.revision,
      body: { strictControl: false },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  return {
    ...w,
    timing,
    read,
    sync,
    synced,
    accepted,
    employment,
    entries,
    entryOf,
    record,
    entryAction,
    internEmployee,
    strictCapacity,
    relaxCapacity,
  };
}
export type SyncWorld = Awaited<ReturnType<typeof syncWorld>>;

/** 同步字段齐全的社招 Offer（带试用期、合同终止日、证件等，供映射断言）。 */
export const fullSocial = (w: SyncWorld, extra: Record<string, unknown> = {}) =>
  w.social({
    mobile: '13800000000',
    gender: 'male',
    idType: 'id_card',
    idNumber: `ID-SYN-${crypto.randomUUID()}`,
    birthDate: '1995-05-05',
    workPlace: '上海',
    hasProbation: true,
    probationMonths: 3,
    contractEndDate: '2028-10-31',
    ...extra,
  });
