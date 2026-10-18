/**
 * BE-14b2 Offer 同步待入职验收夹具：在 BE-14a 夹具上加同步时机设置、立即同步、待入职读取、控编造数与在职实习生造数。
 */
import { expect } from 'vitest';
import { offerWorld, type OfferBody, type OfferWorld } from './AC-OF-BE14a-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { uniqueSuffix } from './support/unique.js';
import type { Db } from '@italent/db';
import {
  DEFAULT_ESTABLISHMENT_CHECKS,
  registerEmploymentActivationChecks,
} from '../../apps/api/src/modules/employment/activation-checks.js';

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
  readonly syncTarget: string | null;
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
  readonly contractCompanyId: string | null;
  readonly probationMonths: number | null;
}

export async function syncWorld<W extends OfferWorld = OfferWorld>(db: Db, label: string, world?: W) {
  const w = (world ?? (await offerWorld(db, label))) as W;
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
  /** 发送 / 重发（b1，OF-R5）：body 可带 confirmed。 */
  const send = (
    offer: Pick<OfferBody, 'id' | 'revision'>,
    body: Record<string, unknown> = {},
    ifMatch = offer.revision,
  ) => w.request('POST', `/${offer.id}/send`, { ifMatch, body });
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
  async function internEmployee(
    name: string,
    employType: 'intern' | 'internal' = 'intern',
    departmentId = w.department.id,
  ) {
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
        fields: { employType, departmentId },
      }),
    });
    expect(hired.status, await hired.clone().text()).toBe(201);
    return employee;
  }
  /** 员工任职记录（按业务类型排列的 kind 与生效日）。 */
  async function recordsOf(employeeId: string) {
    const response = await employment('GET', `/employees/${employeeId}/records?asOf=2026-12-31`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (
      (await response.json()) as { items: { kind: string; effectiveDate: string; fields: Record<string, unknown> }[] }
    ).items;
  }
  /** 已离职实习生：入职 2025-01-01（实习生）、最后工作日 2026-03-31；部门设立日早于入职日。 */
  async function departedIntern(name: string) {
    const org = await w.seeder.request('POST', '/api/tenant/org/organizations', {
      ...as,
      ifMatch: 0,
      body: {
        name: `离职实习部门${uniqueSuffix()}`,
        parents: { admin: { parentId: w.tenant.id } },
        establishedOn: '2025-01-01',
      },
    });
    expect(org.status, await org.clone().text()).toBe(201);
    const created = await employment('POST', '/employees', {
      ifMatch: 0,
      body: { name, code: `DEP_${uniqueSuffix()}` },
    });
    const employee = (await created.json()) as { id: string; revision: number };
    const post = (revision: number, body: Record<string, unknown>) =>
      employment('POST', `/employees/${employee.id}/businesses`, {
        ifMatch: revision,
        body: withLoginEmail(employee.id, body),
      });
    const hired = await post(employee.revision, {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { employType: 'intern', departmentId: ((await org.json()) as { id: string }).id },
    });
    expect(hired.status, await hired.clone().text()).toBe(201);
    const left = await post(((await hired.json()) as { employeeRevision: number }).employeeRevision, {
      kind: 'leave',
      mode: 'direct',
      lastWorkDate: '2026-03-31',
      fields: {},
    });
    expect(left.status, await left.clone().text()).toBe(201);
    return employee;
  }
  /**
   * 严格控编超编：经编制单一判定入口的注入点让部门“已满编”（与 AC-DM-R2 同做法，编制占用本身由 AC-EST-* 覆盖）；
   * 用例结束须 relaxCapacity 或由 afterEach 复位。
   */
  function strictCapacity() {
    registerEmploymentActivationChecks({ establishmentExceeded: async () => true });
  }
  /**
   * 真实编制：新建一个设立日早于年初的部门，建年度方案与该部门的编制（默认严格控制、容量 0）。不注入检查器——
   * 生产的编制入口对 hire 不判容量，Offer 同步靠自己的强控检查（第 4 轮审查 P2-1）。Offer 须录用到返回的部门。
   */
  async function realCapacity(options: { localCapacity?: number; strictControl?: boolean } = {}) {
    const created = await w.seeder.request('POST', '/api/tenant/org/organizations', {
      ...as,
      ifMatch: 0,
      body: {
        name: `真实控编部门${uniqueSuffix()}`,
        parents: { admin: { parentId: w.tenant.id } },
        establishedOn: '2026-01-01',
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id: departmentId } = (await created.json()) as { id: string };
    const post = (path: string, body: object) =>
      w.seeder.request('POST', `/api/tenant/establishment${path}`, { ...as, ifMatch: 0, body });
    const scheme = await post('/schemes', {
      name: `真实同步控编方案${uniqueSuffix()}`,
      periodType: 'annual',
      maintenanceMode: 'local',
      startDate: '2026-01-01',
      occupancyRanges: [{ employmentType: 'internal' }],
    });
    expect(scheme.status, await scheme.clone().text()).toBe(201);
    const capacity = await post('/capacities', {
      orgId: departmentId,
      schemeId: ((await scheme.json()) as { id: string }).id,
      periodStart: '2026-01-01',
      localCapacity: options.localCapacity ?? 0,
      strictControl: options.strictControl ?? true,
    });
    expect(capacity.status, await capacity.clone().text()).toBe(201);
    return { departmentId };
  }
  function relaxCapacity() {
    registerEmploymentActivationChecks(DEFAULT_ESTABLISHMENT_CHECKS);
  }
  /** 同步会校验职级的有效性：夹具里的裸职级对象没有版本，这里建一个真实职级。 */
  const type = await w.seeder.request('POST', '/api/tenant/job/level-types', {
    ...as,
    ifMatch: 0,
    body: { name: '同步职级体系', code: `LT${uniqueSuffix()}`, startDate: '2020-01-01' },
  });
  expect(type.status, await type.clone().text()).toBe(201);
  const level = await w.seeder.request('POST', '/api/tenant/job/levels', {
    ...as,
    ifMatch: 0,
    body: {
      name: '同步职级',
      code: `JL${uniqueSuffix()}`,
      level: 5,
      levelTypeId: ((await type.json()) as { id: string }).id,
      startDate: '2020-01-01',
    },
  });
  expect(level.status, await level.clone().text()).toBe(201);
  const realLevelId = ((await level.json()) as { id: string }).id;
  // 直线上级须在任职生效日处于在职状态：夹具里的裸员工没有任职记录，这里办理一名内部员工入职
  const manager = await internEmployee('在职直线上级', 'internal');
  return {
    ...w,
    realLevelId,
    managerId: manager.id,
    social: (extra: Record<string, unknown> = {}) =>
      w.social({ levelId: realLevelId, directManagerId: manager.id, ...extra }),
    timing,
    read,
    sync,
    send,
    synced,
    accepted,
    employment,
    entries,
    entryOf,
    record,
    entryAction,
    businessRevision,
    internEmployee,
    departedIntern,
    recordsOf,
    strictCapacity,
    realCapacity,
    relaxCapacity,
  };
}
export type SyncWorld = Awaited<ReturnType<typeof syncWorld<OfferWorld>>>;

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
