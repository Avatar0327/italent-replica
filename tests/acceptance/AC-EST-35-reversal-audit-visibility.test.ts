/**
 * AC-EST-35（DEC-273②）：回退超编警告审计里的编制详情（strictControl、segments 的部门 / 职位 / 区间 / 控编模式）
 * 在审计列表、详情与变更值中都按编制数据范围裁剪：有任职查看权但编制范围为空的查看者看不到这些值；
 * 范围只覆盖其他组织的查看者同样看不到；范围覆盖该部门的查看者才看到。
 */
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { auditApi, type DataChangeLog } from './AC-AUD-support.js';
import { configure } from './AC-EST-20-support.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';

const database = useTestDb();
const AUDIT = 'employment.establishment.exceeded-confirmed';
const ESTABLISHMENT = MODULE_OBJECTS.establishment.code;
const ESTABLISHMENT_KEYS = ['strictControl', 'segments'];
/** 查看者对任职业务审计的字段权：含本审计的全部键，裁剪只能来自编制范围。 */
const FIELDS = ['reason', 'action', 'origin', 'confirmed', ...ESTABLISHMENT_KEYS];
/** 编制对象上与回退审计分段对应的字段编码：orgId ↔ departmentId、positionId、strictControl、periodStart / periodEnd ↔ from / until。 */
const ALL_ESTABLISHMENT_FIELDS = ['orgId', 'positionId', 'strictControl', 'periodStart', 'periodEnd', 'localCapacity'];
let w: Awaited<ReturnType<typeof carriedWorld>>;
let businessId: string;

beforeAll(async () => {
  w = await carriedWorld(database().db, 'reversal-audit');
  await configure(w, false);
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01' })).status).toBe(201);
  const outgoing = await w.save(a, {
    withEstablishment: false,
    mode: 'application',
    submit: true,
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(outgoing.status, await outgoing.clone().text()).toBe(201);
  const application = (await outgoing.json()) as { id: string; revision: number };
  businessId = application.id;
  expect((await w.save(b, { withEstablishment: false })).status).toBe(201);
  const withdrawn = await w.session.request('POST', `/businesses/${application.id}/withdraw`, {
    ifMatch: application.revision,
    body: { confirmed: true },
  });
  expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
  expect((await w.auditEvents(application.id)).map((event) => event.action)).toContain(AUDIT);
});

/**
 * 任职看全部；编制范围按参数：null = 无编制数据范围，数组 = 组织范围；
 * establishmentFields = 编制对象可见字段（缺省全部，DEC-284③：编制详情按编制字段权限投影）。
 */
function viewer(establishmentOrgIds: string[] | null, establishmentFields: string[] = ALL_ESTABLISHMENT_FIELDS) {
  const authorize: Authorizer = () => true;
  const establishment: ModuleScope = establishmentOrgIds
    ? {
        ...EMPTY_SCOPE,
        orgIds: establishmentOrgIds,
        hasDataPermission: true,
        terms: [{ dimension: 'organization', orgIds: establishmentOrgIds, personIds: [] }],
      }
    : EMPTY_SCOPE;
  registerScopeProvider(authorize, {
    scope: async (query) =>
      query.objectCode === ESTABLISHMENT ? establishment : { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
    authorize: async () => true,
    fields: async (_tenantId, _userId, objectCode) =>
      new Set(objectCode === ESTABLISHMENT ? establishmentFields : FIELDS),
  });
  return auditApi(w.db, '2026-10-01T01:00:00Z', { authorize });
}
const as = () => ({ tenant: w.session.tenant.id, user: w.session.user.id });

async function reversalLog(audit: ReturnType<typeof viewer>) {
  const page = await audit.dataChanges(as(), { action: AUDIT });
  expect(page.items).toHaveLength(1);
  const row = page.items[0]! as DataChangeLog & { content: string };
  expect(row.objectId).toBe(businessId);
  return { row, detail: await audit.dataChange(as(), row.id) };
}

function establishmentChanges(row: DataChangeLog) {
  return row.changes.filter((change) => ESTABLISHMENT_KEYS.some((key) => change.field.split('.')[0] === key));
}

it('AC-EST-35 有任职查看权、无编制范围：列表变更、内容与详情都没有编制详情', async () => {
  const { row, detail } = await reversalLog(viewer(null));
  expect(row.changes.map((change) => change.field)).toContain('reason');
  expect(establishmentChanges(row)).toEqual([]);
  expect(JSON.stringify(row)).not.toContain(w.to.id);
  expect(JSON.stringify(row)).not.toContain(w.targetPosition);
  expect(row.content).not.toMatch(/strictControl|segments|严格/);
  expect(detail.after).toMatchObject({ reason: 'ESTABLISHMENT_EXCEEDED' });
  for (const key of ESTABLISHMENT_KEYS) expect(detail.after).not.toHaveProperty(key);
  expect(JSON.stringify(detail)).not.toContain(w.to.id);
});

it('AC-EST-35 编制范围只含其他组织：被判超编的部门段同样不可见', async () => {
  const { row, detail } = await reversalLog(viewer([w.from.id]));
  expect(establishmentChanges(row)).toEqual([]);
  expect(JSON.stringify(row)).not.toContain(w.to.id);
  for (const key of ESTABLISHMENT_KEYS) expect(detail.after).not.toHaveProperty(key);
});

it('AC-EST-35 编制范围覆盖该部门：列表变更值与详情都带编制详情', async () => {
  const { row, detail } = await reversalLog(viewer([w.to.id]));
  const segments = row.changes.find((change) => change.field === 'segments');
  expect(segments?.to).toEqual([
    expect.objectContaining({ departmentId: w.to.id, positionId: w.targetPosition, strictControl: false }),
  ]);
  expect(segments?.toText).toContain(w.to.id);
  expect(row.changes.find((change) => change.field === 'strictControl')?.to).toBe(false);
  expect(detail.after).toMatchObject({ strictControl: false });
  expect((detail.after as { segments: unknown[] }).segments).toHaveLength(1);
});

it('AC-EST-35 编制范围全部、编制可见字段只有 orgId：列表、详情、变更值只看到部门', async () => {
  const { row, detail } = await reversalLog(viewer([w.from.id, w.to.id], ['orgId']));
  const segments = row.changes.find((change) => change.field === 'segments');
  expect(segments?.to).toEqual([{ departmentId: w.to.id }]);
  expect(segments?.toText).toContain(w.to.id);
  expect(segments?.toText).not.toContain(w.targetPosition);
  expect(row.changes.find((change) => change.field === 'strictControl')).toBeUndefined();
  // 变更值与文本里没有职位、区间、控编模式（occurredAt 自身带日期，只核对 changes）。
  expect(JSON.stringify(row.changes)).not.toContain(w.targetPosition);
  expect(JSON.stringify(row.changes)).not.toMatch(/strictControl|positionId|2026-10-05/);
  expect(detail.after).not.toHaveProperty('strictControl');
  expect((detail.after as { segments: unknown[] }).segments).toEqual([{ departmentId: w.to.id }]);
});
