import './support/exit-gate-enforced.js';
import { STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, permissionAdmin } from './AC-APV-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const base = '/api/tenant/self-service';
for (const kind of ['exit', 'partTime'] as const) {
  it(`${kind}：AC-ESS-F020 DEC-798 修改字段模式与 PATCH 实际权限一致`, async () => {
    const w = await approvalWorld(database().db, `b6c2-${kind}`);
    await installExitSeeds(database().db, w.tenant.id);
    const department = await w.org('合成部门');
    const actor = await w.person('合成本人', department);
    const api = tenantApi(database().db, { authorize: undefined, clock: w.clock });
    const collection = `${base}/${kind === 'exit' ? 'exit' : 'part-time'}-requests`;
    const request = (path: string, method = 'GET', body?: unknown, revision?: number) =>
      api.request(method, path, { ...w.as(actor.userId), body, ifMatch: revision });
    const initial = await w.json<{ employee: { revision: number } }>(await request(`${collection}/form`));
    const body =
      kind === 'exit'
        ? { lastWorkDate: '2026-12-01' }
        : { partTimeType: 'part_time', startDate: '2026-11-01', fields: { departmentId: department } };
    const draft = await w.json<{ id: string; revision: number }>(
      await request(collection, 'POST', body, initial.employee.revision),
      201,
    );
    const admin = await permissionAdmin(w);
    const profile = await createProfile(admin, 'employee_self_service');
    const preset = STANDARD_PROFILES.find((p) => p.code === 'employee_self_service')!;
    for (const object of preset.objects.filter((o) => o.objectCode.startsWith('TenantBase.'))) {
      await w.json(
        await setObjectPermission(
          admin,
          profile,
          {
            dataOperations: object.dataOperations,
            fields: [...object.fields],
            buttons: [...object.buttons],
          },
          object.objectCode,
        ),
      );
    }
    const code = kind === 'exit' ? 'TenantBase.SelfExit' : 'TenantBase.SelfPartTime';
    const permission = preset.objects.find((o) => o.objectCode === code)!;
    const field = kind === 'exit' ? 'lastWorkDate' : 'endDate';
    const set = async (edit: boolean) =>
      w.json(
        await setObjectPermission(
          admin,
          profile,
          {
            dataOperations: { ...permission.dataOperations, create: false, update: true },
            fields: permission.fields.map((f) => (f.fieldCode === field ? { ...f, edit } : f)),
            buttons: [...permission.buttons],
          },
          code,
        ),
      );
    await set(true);
    const allowedForm = await w.json<Record<string, unknown>>(await request(`${collection}/form`));
    expect(allowedForm).toMatchObject({
      dataOperations: { create: false, update: true },
      fieldModes: { [field]: 'readonly' },
      updateFieldModes: { [field]: 'editable' },
    });
    const changed = await w.json<{ revision: number }>(
      await request(`${collection}/${draft.id}`, 'PATCH', { [field]: '2026-12-02' }, draft.revision),
    );
    await set(false);
    const deniedForm = await w.json<Record<string, unknown>>(await request(`${collection}/form`));
    expect(deniedForm).toMatchObject({ updateFieldModes: { [field]: 'readonly' } });
    expect(Object.keys(allowedForm.updateFieldModes as object)).toEqual(Object.keys(allowedForm.fieldModes as object));
    expect(deniedForm.fieldModes).toEqual(allowedForm.fieldModes);
    expect(deniedForm.dataOperations).toEqual(allowedForm.dataOperations);
    const denied = await request(`${collection}/${draft.id}`, 'PATCH', { [field]: '2026-12-03' }, changed.revision);
    expect(denied.status).toBe(403);
  });
}
