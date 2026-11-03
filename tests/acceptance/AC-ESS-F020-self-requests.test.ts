import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { EMPLOYEE_DEFAULT_EDIT_FIELDS, STANDARD_PROFILES, STANDARD_GRANT_VERSION } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyInitiationSubset } from '../../apps/api/src/modules/employment/exit-initiation.js';
import { approvalWorld, permissionAdmin, type Person } from './AC-APV-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { tenantApi } from './support/tenant-api.js';
import { legacyWorld, runBackfill, permissionOf } from './support/f061.js';

const database = useTestDb();
const BASE = '/api/tenant/self-service';
const OBJECT = 'TenantBase.EmploymentRecord';
const carriers = { exit: 'TenantBase.SelfExit', partTime: 'TenantBase.SelfPartTime' };
type Receipt = { id: string; revision: number; status: string; employeeId: string; fields?: object };
let w: Awaited<ReturnType<typeof approvalWorld>>;
let api: ReturnType<typeof tenantApi>;
let department: string;
let target: string;
let root: string;
let manager: Person;
const send = (actor: Person, path: string, method = 'GET', body?: unknown, revision?: number, key?: string) =>
  api.request(method, `${BASE}${path}`, { ...w.as(actor.userId), body, ifMatch: revision, idempotencyKey: key });
const fresh = () => w.person('合成本人员工', department);
const pt = () => ({ partTimeType: 'part_time', startDate: '2026-11-01', fields: { departmentId: target } });
const opening = async (actor: Person, kind: string) =>
  w.json<{ employee: { id: string; revision: number }; fieldModes: Record<string, string> }>(
    await send(actor, `/${kind}/form`),
  );
const create = async (actor: Person, kind: string, body: object) => {
  const form = await opening(actor, kind);
  return w.json<Receipt>(await send(actor, `/${kind}`, 'POST', body, form.employee.revision), 201);
};

beforeAll(async () => {
  w = await approvalWorld(database().db, 'ess-f020');
  await installExitSeeds(database().db, w.tenant.id);
  api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
  department = await w.org('合成主职部门');
  target = await w.org('合成范围外部门');
  root = w.tenant.id;
  manager = await w.person('合成直线经理', department);
  for (const approvalType of ['leave', 'part_time_add', 'transfer'])
    await w.publishedProcess({
      approvalType,
      isFallback: true,
      conditions: { items: [], expression: '' },
      nodes: [{ key: 'review', approver: { type: 'specified', value: manager.userId } }],
    });
});

describe('AC-ESS-F020 / DEC-790 本人申请', () => {
  it('专属默认字段、两按钮与授权 44；共享调动字段集合不变', () => {
    expect(STANDARD_GRANT_VERSION).toBe(44);
    expect(EMPLOYEE_DEFAULT_EDIT_FIELDS).toEqual(['effectiveDate', 'reasonCode', 'departmentId', 'directManagerId']);
    const employee = STANDARD_PROFILES.find((p) => p.code === 'employee_self_service')!;
    expect(employee.objects.find((o) => o.objectCode === OBJECT)?.buttons).toEqual(
      expect.arrayContaining(['Exit.Self', 'PartTime.Self'].map((buttonCode) => ({ buttonCode, level: 'detail' }))),
    );
    for (const objectCode of Object.values(carriers))
      expect(employee.objects.find((o) => o.objectCode === objectCode)?.dataOperations.create).toBe(true);
  });

  it('本人去向选填、原因默认；HR 与经理的既有校验不变', () => {
    expect(applyInitiationSubset('self', 'application', {})).toEqual({ reasonCode: 'personal' });
    expect(applyInitiationSubset('hr', 'application', { exitTypeCode: 'voluntary' })).toEqual({
      exitTypeCode: 'voluntary',
    });
    expect(() => applyInitiationSubset('manager', 'application', {})).toThrow('请选择离职后去向');
    expect(() => applyInitiationSubset('self', 'application', { reasonCode: 'invalid' })).toThrow();
  });

  it('离职默认字段投影、建草稿/暂存/冲突/提交及只读回查；不收附件和他人 ID', async () => {
    const actor = await fresh();
    const form = await opening(actor, 'exit-requests');
    expect(form.fieldModes).toMatchObject({ lastWorkDate: 'editable', whereaboutsCode: 'editable' });
    for (const body of [
      {},
      { lastWorkDate: 'invalid' },
      { lastWorkDate: '2026-12-01', whereaboutsCode: 'invalid' },
      { lastWorkDate: '2026-12-01', attachmentRefs: [] },
      { lastWorkDate: '2026-12-01', employeeId: manager.employeeId },
      { lastWorkDate: '2026-12-01', employeeId: randomUUID() },
      { lastWorkDate: '2026-12-01', exitTypeCode: 'voluntary' },
    ])
      expect((await send(actor, '/exit-requests', 'POST', body, form.employee.revision)).status).toBe(400);
    const draft = await create(actor, 'exit-requests', { lastWorkDate: '2026-12-01' });
    expect(draft).toMatchObject({
      employeeId: actor.employeeId,
      status: 'draft',
      reasonCode: 'personal',
      lastWorkDate: '2026-12-01',
    });
    const path = `/exit-requests/${draft.id}`;
    const changed = await w.json<Receipt>(
      await send(
        actor,
        path,
        'PATCH',
        { reasonCode: 'family', whereaboutsCode: 'startup', lastWorkDate: '2026-12-02' },
        draft.revision,
      ),
    );
    expect((await send(actor, path, 'PATCH', { reasonCode: 'personal' }, draft.revision)).status).toBe(409);
    const read = await w.json<Receipt>(await send(actor, path));
    const reverted = await w.json<Receipt>(
      await send(
        actor,
        path,
        'PATCH',
        { reasonCode: 'personal', whereaboutsCode: '', lastWorkDate: '2026-12-01' },
        read.revision,
      ),
    );
    expect(reverted.revision).toBeGreaterThan(changed.revision);
    const submitKey = randomUUID();
    const submitted = await w.json<Receipt>(
      await send(actor, `${path}/submit`, 'POST', {}, reverted.revision, submitKey),
    );
    expect(await w.json(await send(actor, `${path}/submit`, 'POST', {}, reverted.revision, submitKey))).toMatchObject({
      id: draft.id,
    });
    expect((await send(actor, path, 'PATCH', { reasonCode: 'family' }, submitted.revision)).status).toBe(409);
    expect(submitted.status).toBe('in_review');
    const other = await send(manager, path);
    const missing = await send(manager, `/exit-requests/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(other.status);
    expect(await missing.json()).toEqual(await other.json());
    const list = await w.json<{ items: { id: string; businessId: string }[] }>(await send(actor, '/applications'));
    const item = list.items.find((i) => i.businessId === draft.id)!;
    expect(item).toBeDefined();
    expect(await w.json(await send(actor, `/applications/${item.id}`))).toMatchObject({ status: '审批中' });
    expect((await send(manager, `/applications/${item.id}`)).status).toBe(404);
  });

  it('兼职范围外部门/经理可选、根不可选；建草稿/暂存/提交进入既有审批和我的申请', async () => {
    const actor = await fresh();
    const form = await opening(actor, 'part-time-requests');
    expect(form.fieldModes).toMatchObject({ partTimeType: 'editable', postId: 'readonly', levelId: 'readonly' });
    for (const employeeId of [manager.employeeId, randomUUID()])
      expect(
        (await send(actor, '/part-time-requests', 'POST', { ...pt(), employeeId }, form.employee.revision)).status,
      ).toBe(400);
    const choices = await w.json<{ items: { id: string; selectable: boolean }[] }>(
      await send(actor, '/part-time-requests/references/departmentId?asOf=2026-11-01'),
    );
    expect(choices.items).toContainEqual(expect.objectContaining({ id: target, selectable: true }));
    expect(choices.items).toContainEqual(expect.objectContaining({ id: root, selectable: false }));
    const managers = await w.json<{ items: { id: string }[] }>(
      await send(actor, '/part-time-requests/references/directManagerId?asOf=2026-11-01'),
    );
    expect(managers.items.map((m) => m.id)).toContain(manager.employeeId);
    expect(
      (
        await send(
          actor,
          '/part-time-requests',
          'POST',
          {
            ...pt(),
            fields: { departmentId: root },
          },
          form.employee.revision,
        )
      ).status,
    ).toBe(400);
    const draft = await create(actor, 'part-time-requests', {
      ...pt(),
      fields: { departmentId: target, directManagerId: manager.employeeId },
    });
    const path = `/part-time-requests/${draft.id}`;
    const saved = await w.json<Receipt>(await send(actor, path, 'PATCH', { endDate: '2027-01-01' }, draft.revision));
    expect((await send(actor, path, 'PATCH', { endDate: '2027-02-01' }, draft.revision)).status).toBe(409);
    const current = await w.json<Receipt>(await send(actor, path));
    expect(current.revision).toBe(saved.revision);
    const restoreKey = randomUUID();
    const restored = await w.json<Receipt>(
      await send(actor, path, 'PATCH', { endDate: null }, current.revision, restoreKey),
    );
    expect(
      await w.json(await send(actor, path, 'PATCH', { endDate: null }, current.revision, restoreKey)),
    ).toMatchObject({ id: restored.id, revision: restored.revision });
    const submitKey = randomUUID();
    const submitted = await w.json<Receipt>(
      await send(actor, `${path}/submit`, 'POST', {}, restored.revision, submitKey),
    );
    expect(await w.json(await send(actor, `${path}/submit`, 'POST', {}, restored.revision, submitKey))).toMatchObject({
      id: submitted.id,
      status: 'in_review',
    });
    expect(submitted.status).toBe('in_review');
    expect((await send(manager, path)).status).toBe(404);
    const list = await w.json<{ items: { id: string; businessId: string }[] }>(await send(actor, '/applications'));
    const item = list.items.find((i) => i.businessId === draft.id)!;
    expect(item).toBeDefined();
    expect(await w.json(await send(actor, `/applications/${item.id}`))).toMatchObject({ status: '审批中' });
    expect((await send(manager, `/applications/${item.id}`)).status).toBe(404);
  });

  it('同键重放不重复建单；撤按钮/字段后重放拒绝，相邻调动与档案不扩权', async () => {
    const actor = await fresh();
    const form = await opening(actor, 'part-time-requests');
    const key = randomUUID();
    const draft = await w.json<Receipt>(
      await send(actor, '/part-time-requests', 'POST', pt(), form.employee.revision, key),
      201,
    );
    expect(
      await w.json(await send(actor, '/part-time-requests', 'POST', pt(), form.employee.revision, key), 201),
    ).toMatchObject({ id: draft.id });
    const exitActor = await fresh();
    const exitDraft = await create(exitActor, 'exit-requests', { lastWorkDate: '2026-12-01' });
    const submitKey = randomUUID();
    const submitPath = `/exit-requests/${exitDraft.id}/submit`;
    expect((await send(exitActor, submitPath, 'POST', {}, exitDraft.revision, submitKey)).status).toBe(200);
    const admin = await permissionAdmin(w);
    const profile = await createProfile(admin, 'employee_self_service');
    const preset = STANDARD_PROFILES.find((p) => p.code === 'employee_self_service')!;
    for (const object of preset.objects.filter((o) => o.objectCode.startsWith('TenantBase.')))
      await w.json(
        await setObjectPermission(
          admin,
          profile,
          { dataOperations: object.dataOperations, fields: [...object.fields], buttons: [...object.buttons] },
          object.objectCode,
        ),
      );
    const employment = preset.objects.find((o) => o.objectCode === OBJECT)!;
    // P1-1：同一员工的两类已提交单据；另一个员工的调动证明既有类型不受两按钮影响。
    await w.json(await send(actor, `/part-time-requests/${draft.id}/submit`, 'POST', {}, draft.revision));
    const ownExit = await create(actor, 'exit-requests', { lastWorkDate: '2026-12-01' });
    await w.json(await send(actor, `/exit-requests/${ownExit.id}/submit`, 'POST', {}, ownExit.revision));
    const transferActor = await fresh();
    const transferForm = await opening(transferActor, 'exit-requests');
    await w.json(
      await send(
        transferActor,
        '/transfer',
        'POST',
        {
          effectiveDate: '2026-11-01',
          fields: { departmentId: target },
        },
        transferForm.employee.revision,
      ),
      201,
    );
    const list = async (person: Person, page = 1, pageSize = 100) =>
      w.json<{ items: { businessId: string; applicationKind?: string }[]; page: number; pageSize: number }>(
        await send(person, `/applications?page=${page}&pageSize=${pageSize}`),
      );
    const original = (await list(actor)).items;
    expect(original.map((item) => item.businessId).sort()).toEqual([draft.id, ownExit.id].sort());
    const transferItems = (await list(transferActor)).items;
    expect(transferItems).toHaveLength(1);
    for (const denied of [['Exit.Self'], ['PartTime.Self'], ['Exit.Self', 'PartTime.Self'], []]) {
      await w.json(
        await setObjectPermission(
          admin,
          profile,
          {
            dataOperations: employment.dataOperations,
            fields: [...employment.fields],
            buttons: employment.buttons.filter((button) => !denied.includes(button.buttonCode)),
          },
          OBJECT,
        ),
      );
      const expected = original.filter(
        (item) => !denied.includes(item.applicationKind === 'exit' ? 'Exit.Self' : 'PartTime.Self'),
      );
      // 完整条数与每页顺序都按授权后集合断言，不能先 LIMIT/OFFSET 再过滤制造空页。
      expect((await list(actor)).items, `撤销 ${denied.join('/')} 后列表不披露相应类型元数据`).toEqual(expected);
      for (let page = 1; page <= expected.length + 1; page++) {
        const actual = await list(actor, page, 1);
        expect(actual).toMatchObject({ page, pageSize: 1 });
        expect(actual.items).toEqual(expected.slice(page - 1, page));
      }
      expect((await list(transferActor)).items).toEqual(transferItems);
    }
    await w.json(
      await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: employment.dataOperations,
          fields: [...employment.fields],
          buttons: employment.buttons.filter((b) => !['PartTime.Self', 'Exit.Self'].includes(b.buttonCode)),
        },
        OBJECT,
      ),
    );
    expect((await send(actor, '/part-time-requests', 'POST', pt(), form.employee.revision, key)).status).toBe(403);
    expect((await send(actor, '/exit-requests/form')).status).toBe(403);
    expect((await send(exitActor, submitPath, 'POST', {}, exitDraft.revision, submitKey)).status).toBe(403);
    expect(
      (
        await send(actor, '/transfer/preview', 'POST', {
          effectiveDate: '2026-11-01',
          fields: { departmentId: target },
        })
      ).status,
    ).toBe(200);
    await w.json(
      await setObjectPermission(
        admin,
        profile,
        { dataOperations: employment.dataOperations, fields: [...employment.fields], buttons: [...employment.buttons] },
        OBJECT,
      ),
    );
    const exitPermission = preset.objects.find((o) => o.objectCode === carriers.exit)!;
    await w.json(
      await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: exitPermission.dataOperations,
          buttons: [],
          fields: exitPermission.fields.filter((f) => f.fieldCode !== 'lastWorkDate'),
        },
        carriers.exit,
      ),
    );
    expect((await send(exitActor, submitPath, 'POST', {}, exitDraft.revision, submitKey)).status).toBe(403);
    expect(await w.json(await send(exitActor, `/exit-requests/${exitDraft.id}`))).not.toHaveProperty('lastWorkDate');
    const special = preset.objects.find((o) => o.objectCode === carriers.partTime)!;
    await w.json(
      await setObjectPermission(
        admin,
        profile,
        {
          dataOperations: special.dataOperations,
          buttons: [...special.buttons],
          fields: special.fields.filter((f) => f.fieldCode !== 'departmentId'),
        },
        carriers.partTime,
      ),
    );
    expect((await send(actor, '/part-time-requests', 'POST', pt(), form.employee.revision, key)).status).toBe(403);
    const hidden = await w.json<{ fields: object }>(await send(actor, `/part-time-requests/${draft.id}`));
    expect(hidden.fields).not.toHaveProperty('departmentId');
    const own = await w.json<{ record: Record<string, unknown> }>(await send(actor, '/profile'));
    expect(own.record).not.toHaveProperty('serviceType');
    await w.json(
      await setObjectPermission(
        admin,
        profile,
        { dataOperations: special.dataOperations, fields: [...special.fields], buttons: [...special.buttons] },
        carriers.partTime,
      ),
    );
    await withTenant(database().db, w.tenant.id, (tx) =>
      tx.execute(sql`
      DELETE FROM permission_user_person_links WHERE tenant_id=${w.tenant.id} AND user_id=${actor.userId}::uuid
    `),
    );
    expect((await send(actor, '/part-time-requests', 'POST', pt(), form.employee.revision, key)).status).toBe(403);
  });

  it('授权 44 为已有标准员工身份补入专属字段和两个按钮', async () => {
    expect(STANDARD_GRANT_VERSION).toBe(44);
    const old = (p: (typeof STANDARD_PROFILES)[number]) =>
      p.code !== 'employee_self_service'
        ? p
        : {
            ...p,
            objects: p.objects
              .filter((o) => !Object.values(carriers).includes(o.objectCode))
              .map((o) => ({
                ...o,
                buttons: o.buttons.filter((b) => !['Exit.Self', 'PartTime.Self'].includes(b.buttonCode)),
              })),
          };
    const legacy = await legacyWorld(database().db, 'ess-f020-upgrade', [old]);
    await runBackfill(legacy);
    const actual = await permissionOf(legacy, 'employee_self_service', OBJECT);
    expect(actual?.buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ buttonCode: 'Exit.Self' }),
        expect.objectContaining({ buttonCode: 'PartTime.Self' }),
      ]),
    );
    expect(await permissionOf(legacy, 'employee_self_service', carriers.exit)).toBeDefined();
  });
});
