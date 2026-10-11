import { vi } from 'vitest';
import type { Obligation, RequiredTable } from './required/types.js';

// 只改变当前测试进程读到的真实登记；产品、声明、冻结文件与测试主体均保持原样。
vi.mock('./required/index.js', async (original) => {
  const actual = await original<{ REQUIRED: RequiredTable }>();
  const endpoints = new Set([
    'GET /api/tenant/employment/transfers/manager',
    'GET /api/tenant/talent/criteria/:id/model-image',
    'GET /api/tenant/personnel/employees/:id',
    'GET /api/tenant/idp/approval-processes',
  ]);
  const missingEndpoints = process.env['ROUTE_POLICY_TEST_OMISSION'] === 'endpoints';
  const table: RequiredTable = Object.fromEntries(
    Object.entries(actual.REQUIRED)
      .filter(([key]) => !missingEndpoints || !endpoints.has(key))
      .map(([key, obligations]) => [
        key,
        missingEndpoints
          ? obligations
          : obligations.map((o) => (o.purpose?.startsWith('guard:') ? ({ ...o, inner: undefined } as Obligation) : o)),
      ]),
  );
  return { ...actual, REQUIRED: table };
});
