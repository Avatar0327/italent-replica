import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { createRig, discoverAll, type EndpointDiscovery } from './support/route-policy/discovery.js';
import type { ManifestRoute } from '@italent/api';
import type { Finding } from './support/route-policy/compare.js';
import { registration, registrationGate, compareRegisteredDeclarations } from './support/route-policy/registration.js';
import { checkRequired } from './support/route-policy/required.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';

const testDb = useTestDb();
const tables: Record<string, RequiredTable> = { complete: REQUIRED };
const assessments: Record<string, Finding[]> = {};
let routes: readonly ManifestRoute[];
let discoveries: Record<string, EndpointDiscovery>;
const omitted = new Set([
  'GET /api/tenant/employment/transfers/manager',
  'GET /api/tenant/talent/criteria/:id/model-image',
  'GET /api/tenant/personnel/employees/:id',
  'GET /api/tenant/idp/approval-processes',
]);

beforeAll(async () => {
  const { rig, manifest } = await createRig(testDb().db);
  routes = manifest.declared;
  discoveries = await discoverAll(rig, routes);
  const contract = readFrozenContract();
  if (!contract) throw new Error('真实冻结基准不存在');
  tables['endpoints'] = Object.fromEntries(Object.entries(REQUIRED).filter(([key]) => !omitted.has(key)));
  tables['guard-inner'] = Object.fromEntries(
    Object.entries(REQUIRED).map(([key, os]) => [
      key,
      os.map((o) => (o.purpose?.startsWith('guard:') ? ({ ...o, inner: undefined } as Obligation) : o)),
    ]),
  );
  // 局部用例由外层 FW 全套各自运行；这里复用一次真实探测与每种登记的一次静态比较，不再嵌套启动整组 Vitest。
  for (const [name, table] of Object.entries(tables)) {
    assessments[name] = [
      ...checkRequired(table, contract, routes),
      ...compareRegisteredDeclarations(contract, routes, undefined, table),
    ];
  }
}, 600_000);

const check = (name: string, strict: boolean) => [
  ...registrationGate(assessments[name]!, name, { strict }),
  ...registrationGate({ discoveries, routes, table: tables[name]! }, name, { strict }),
];

describe('AC-PRM-FW-F090b 单一真实登记入口（DEC-431①；#248 P2-1 / P3-1）', () => {
  it('真实登记门禁不吞读取 / 解析等未知异常', () => {
    expect(() =>
      registration('未知读取错误', () => {
        throw new Error('未知读取错误');
      }),
    ).toThrow('未知读取错误');
  });
  it.each([false, true])('完整登记：strict=%s 不把已知台账记录当差异', (strict) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(check('complete', strict)).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it.each(['endpoints', 'guard-inner'])('%s：默认通过只警告，严格模式判红', (name) => {
    const code = name === 'endpoints' ? 'REQUIRED_ENTRY_MISSING' : 'GUARD_ROLE_UNBOUND';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(check(name, false)).toEqual([]);
      expect(warn.mock.calls.flat().join('\n')).toContain('[证据门禁·警告]');
      expect(warn.mock.calls.flat().join('\n')).toContain(code);
      const strict = check(name, true);
      expect(strict.map((f) => f.code)).toContain(code);
      expect(() => expect(strict).toEqual([])).toThrow(expect.objectContaining({ name: 'AssertionError' }));
      console.info(`${name}：默认仅警告，严格 ${strict.length} 项真实登记差异`);
    } finally {
      warn.mockRestore();
    }
  });
});
