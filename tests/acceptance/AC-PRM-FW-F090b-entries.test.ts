import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { createRig, discoverAll, type EndpointDiscovery } from './support/route-policy/discovery.js';
import type { ManifestRoute } from '@italent/api';
import type { Finding } from './support/route-policy/compare.js';
import {
  registration,
  registrationIt,
  registrationDrift,
  registrationGate,
  compareRegisteredDeclarations,
} from './support/route-policy/registration.js';
import { checkRequired } from './support/route-policy/required.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';

// 捕获 registrationIt 注册的真实回调，在当前进程里执行默认 / 严格两种环境。
const captured = vi.hoisted(() => ({ active: false, callback: undefined as (() => void) | undefined }));
vi.mock('vitest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vitest')>();
  return {
    ...actual,
    it: Object.assign((label: string, verify: () => void) => {
      if (captured.active) captured.callback = verify;
      else return actual.it(label, verify);
    }, actual.it),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  captured.active = false;
  captured.callback = undefined;
});

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

describe('AC-PRM-FW-F095 包装入口委托 registrationGate（DEC-416③）', () => {
  it.each(['registration', 'registrationIt', 'registrationDrift'] as const)(
    '%s：默认警告 / 严格失败，完整正例不警告',
    (entry) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const invoke = (different: boolean) => {
        if (entry === 'registrationDrift') {
          expect(registrationDrift('包装文本差异', different ? ['局部差异'] : [])).toEqual([]);
          return;
        }
        const verify = () => expect(different ? '局部差异' : '完整登记').toBe('完整登记');
        if (entry === 'registration') return registration('包装断言差异', verify);
        captured.active = true;
        try {
          registrationIt('包装用例差异', verify);
        } finally {
          captured.active = false;
        }
        expect(captured.callback).toBeTypeOf('function');
        captured.callback!();
      };
      for (const strict of [false, true]) {
        vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict ? '1' : '0');
        warn.mockClear();
        expect(() => invoke(false)).not.toThrow();
        expect(warn).not.toHaveBeenCalled();
        if (strict) {
          expect(() => invoke(true)).toThrow(expect.objectContaining({ name: 'AssertionError' }));
          expect(warn).not.toHaveBeenCalled();
        } else {
          expect(() => invoke(true)).not.toThrow();
          expect(warn.mock.calls.flat().join('\n')).toContain('[证据门禁·警告]');
          expect(warn.mock.calls.flat().join('\n')).toContain('局部差异');
        }
      }
    },
  );
});
