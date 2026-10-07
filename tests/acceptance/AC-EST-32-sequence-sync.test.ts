import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { scenario, worker } from './AC-JOB-sequence-support.js';
import { MODULE_OBJECTS } from '@italent/domain';
import type { Authorizer } from '@italent/api';
import { tenantApi } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';

const database = useTestDb();
for (const strict of [false, true])
  for (const kind of ['posts', 'positions'] as const)
    it(`AC-EST-32 批量同步序列按未来条件返回警告并裁剪 ${kind} strict=${strict}`, async () => {
      const db = database().db;
      const s = await scenario(db, kind);
      await s.world.hire('已占编员工', {
        departmentId: s.org.id,
        sequenceId: s.nextSequence.id,
      });
      const created = await s.world.call('POST', 'establishment/schemes', {
        ifMatch: 0,
        body: {
          name: '序列占编',
          periodType: 'monthly',
          maintenanceMode: 'local',
          subdivision: 'none',
          startDate: '2026-10-01',
          occupancyRanges: [{ employmentType: 'internal', conditions: { dimension2: ['never'] } }],
        },
      });
      expect(created.status, await created.clone().text()).toBe(201);
      const scheme = (await created.json()) as { id: string; revision: number };
      const changed = await s.world.call('PATCH', `establishment/schemes/${scheme.id}`, {
        ifMatch: scheme.revision,
        body: {
          effectiveDate: '2026-10-15',
          occupancyRanges: [{ employmentType: 'internal', conditions: { sequenceId: [s.nextSequence.id] } }],
        },
      });
      expect(changed.status, await changed.clone().text()).toBe(200);
      const capacity = await s.world.call('POST', 'establishment/capacities', {
        ifMatch: 0,
        body: {
          orgId: s.org.id,
          schemeId: scheme.id,
          periodStart: '2026-10-01',
          localCapacity: 1,
          strictControl: strict,
        },
      });
      expect(capacity.status, await capacity.clone().text()).toBe(201);
      const queued = await s.call(
        'PATCH',
        `${kind}/${s.target.id}`,
        {
          sequenceId: s.nextSequence.id,
          effectiveDate: '2026-10-05',
        },
        1,
      );
      expect(queued.status, await queued.clone().text()).toBe(200);
      expect(await worker(db, s.world.tenant.id)).toMatchObject({ completed: 1, failed: 0 });
      const response = await s.call('GET', 'sequence-sync/messages');
      const { items } = (await response.json()) as { items: { message: { taskId: string; warnings?: unknown[] } }[] };
      expect(items).toHaveLength(1);
      expect(items[0]!.message.warnings).toEqual([{ recordId: s.future.id, reason: 'ESTABLISHMENT_EXCEEDED' }]);
      const path = `sequence-sync/tasks/${items[0]!.message.taskId}`;
      const result = await s.call('GET', path);
      expect(await result.json()).toMatchObject({ result: { warnings: items[0]!.message.warnings } });
      expect((await s.world.record(s.future.id)).fields.sequenceId).toBe(s.nextSequence.id);
      const after = await s.world.employmentRecords(s.employee.id);
      expect(await worker(db, s.world.tenant.id)).toMatchObject({ completed: 0, failed: 0 });
      expect(await s.world.employmentRecords(s.employee.id)).toEqual(after);

      const authorize: Authorizer = () => true;
      registerScopeProvider(authorize, {
        authorize: async () => true,
        scope: async () => EMPTY_SCOPE,
        fields: async (query) =>
          query.objectCode === MODULE_OBJECTS.employmentRecord.code ? new Set(['id']) : undefined,
      });
      const api = tenantApi(db, { authorize });
      for (const endpoint of ['sequence-sync/messages', path]) {
        const hidden = await api.request('GET', `/api/tenant/job/${endpoint}`, {
          user: s.world.user.id,
          tenant: s.world.tenant.id,
        });
        expect(hidden.status).toBe(200);
        const body = await hidden.json();
        expect(JSON.stringify(body)).not.toContain(s.future.id);
        const receipt = endpoint.endsWith('/messages') ? body.items[0].message : body.result;
        expect(receipt).toMatchObject({ count: 0, warnings: [] });
      }
    });
