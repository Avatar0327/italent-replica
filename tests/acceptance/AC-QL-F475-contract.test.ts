import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { qualificationWorld } from './AC-QL-support.js';
import { qualificationResources } from '../../apps/web/src/qualification/resources.js';
import { saveResource } from '../../apps/web/src/talent/catalog/api.js';
import { newCommand, type ApiClient } from '../../apps/web/src/foundation/client.js';
import type { Row } from '../../apps/web/src/talent/catalog/types.js';

const testDb = useTestDb();
it('AC-QL F-475 补页使用真实接口回执，编辑等级保留行 ID，指标采用接口字段', async () => {
  const world = await qualificationWorld(testDb().db, 'f475-contract');
  const api: ApiClient = {
    async request<T>(path, options = {}) {
      const method = options.method ?? 'GET';
      const response = await world.request(method, path.replace('/api/tenant/qualification', ''), {
        body: options.command?.body,
        ifMatch: options.command?.revision,
        idempotencyKey: options.command?.id,
      });
      return world.ok<T>(response, method === 'POST' ? 201 : 200);
    },
  };
  const schemes = qualificationResources.find((row) => row.key === 'grade-schemes')!;
  const created = await saveResource(
    api,
    schemes,
    {
      name: '合成方案',
      description: '合成说明',
      details: [{ grade: 0, name: '基础', score: 0, description: null }],
    },
    null,
  );
  const details = created.details as Row[];
  expect(details[0]).toMatchObject({ grade: 0, score: 0, name: '基础' });
  const body = { details: [{ ...details[0], name: '基础乙' }] };
  const changed = await saveResource(api, schemes, body, created, newCommand(body, created.revision));
  expect(changed.revision).toBeGreaterThan(created.revision);
  expect(changed.details).toEqual([{ ...details[0], name: '基础乙' }]);
  const type = await world.targetType();
  const targets = qualificationResources.find((row) => row.key === 'targets')!;
  const target = await saveResource(
    api,
    targets,
    {
      name: '合成指标',
      typeId: type.id,
      evalMode: 'score',
      description: '合成指标说明',
    },
    null,
  );
  expect(target).toMatchObject({ typeId: type.id, evalMode: 'score', description: '合成指标说明' });
});
