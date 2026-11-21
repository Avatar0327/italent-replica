import { routeManifest } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { BASE } from './AC-ESIGN-F505-s5-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const endpoints = new Set([
  `GET ${BASE}/:id/esign-context`,
  `POST ${BASE}/:id/esign-tasks`,
  `GET ${BASE}/:id/esign-records`,
]);

it('AC-22 三条入职签署路由都在运行时策略清单', () => {
  const routes = routeManifest(tenantApi(database().db).app).declared;
  expect(routes.filter(({ key }) => endpoints.has(key)).map(({ key }) => key).sort()).toEqual([...endpoints].sort());
});
