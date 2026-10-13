import * as evidence from './support/route-policy/evidence.js';
import { requiredChecks } from './support/route-policy/local-checks/required.js';
import { disclosureChecks } from './support/route-policy/local-checks/disclosure.js';
import { bindingChecks } from './support/route-policy/local-checks/binding.js';
import { discoveryChecks } from './support/route-policy/local-checks/discovery.js';
import { qualificationSubsetChecks } from './support/route-policy/local-checks/qualification-subset.js';
import { qualificationChecks } from './support/route-policy/local-checks/qualification.js';
import { survey360Checks } from './support/route-policy/local-checks/survey360.js';
import { weakeningsChecks } from './support/route-policy/local-checks/weakenings.js';
import { fw02Checks } from './support/route-policy/local-checks/fw-02.js';
import type * as Vitest from 'vitest';
import { useTestDb } from '@italent/testkit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { createRig, discoverAll, type EndpointDiscovery } from './support/route-policy/discovery.js';
import type { ManifestRoute } from '@italent/api';
import type { ObservedContract } from './support/route-policy/contract.js';
import {
  registration,
  registrationIt,
  registrationDrift,
  registrationGate,
} from './support/route-policy/registration.js';
import { REQUIRED } from './support/route-policy/required/index.js';
import type { Obligation, RequiredTable } from './support/route-policy/required/types.js';

// 捕获 registrationIt 注册的真实回调，在当前进程里执行默认 / 严格两种环境。
const captured = vi.hoisted(() => ({ active: false, callback: undefined as (() => void) | undefined }));
vi.mock('vitest', async (importOriginal) => {
  const actual = await importOriginal<typeof Vitest>();
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
let contract: ObservedContract;
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
  const stored = readFrozenContract();
  if (!stored) throw new Error('真实冻结基准不存在');
  contract = stored;
  tables['endpoints'] = Object.fromEntries(Object.entries(REQUIRED).filter(([key]) => !omitted.has(key)));
  tables['guard-inner'] = Object.fromEntries(
    Object.entries(REQUIRED).map(([key, os]) => [
      key,
      os.map((o) => (o.purpose?.startsWith('guard:') ? ({ ...o, inner: undefined } as Obligation) : o)),
    ]),
  );
}, 600_000);

const groups = {
  required: requiredChecks,
  disclosure: disclosureChecks,
  binding: bindingChecks,
  discovery: discoveryChecks,
  'qualification-subset': qualificationSubsetChecks,
  qualification: qualificationChecks,
  survey360: survey360Checks,
  weakenings: weakeningsChecks,
  'FW-02': fw02Checks,
};

// 每种登记副本独立缓存；两种模式仍逐项重跑共享断言和 registration 包装。
const calculations = new Map<string, Map<string, unknown>>();
function check(name: string, strict: boolean) {
  vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict ? '1' : '0');
  const values = calculations.get(name) ?? new Map<string, unknown>();
  calculations.set(name, values);
  const evaluate = <T>(key: string, calculate: () => T): T => {
    // 只在成功计算后写入：读取 / 解析等未知异常不能被缓存或转换。
    if (!values.has(key)) values.set(key, calculate());
    return values.get(key) as T;
  };
  const failures: { group: string; label: string; message: string }[] = [];
  const executed: string[] = [];
  for (const [group, checksOf] of Object.entries(groups)) {
    const checks = checksOf({ table: tables[name]!, routes, contract, discoveries, evaluate });
    expect(checks.length, group).toBeGreaterThan(0);
    for (const check of checks) {
      executed.push(`${group}:${check.id}`);
      try {
        // 原 registrationIt 用例的回调通过同一个 registration 分流；包装注册本身在下方独立验证。
        if (check.wrapped) registration(check.label, check.verify);
        else check.verify();
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'AssertionError') throw error;
        failures.push({ group, label: check.label, message: error.message });
      }
    }
  }
  return { failures, executed };
}

describe('AC-PRM-FW-F090b 单一真实登记入口（DEC-431①；#248 P2-1 / P3-1）', () => {
  it('真实登记门禁不吞读取 / 解析等未知异常', () => {
    expect(() =>
      registration('未知读取错误', () => {
        throw new Error('未知读取错误');
      }),
    ).toThrow('未知读取错误');
  });
  // F-116：全表扫描在 PG 分片 / 高负载下超过全局 30 秒（#293 整个文件约 98 秒），仅这几条单独放宽到 120 秒。
  it.each([false, true])(
    '完整登记：strict=%s 不把已知台账记录当差异',
    (strict) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(check('complete', strict).failures).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
    120_000,
  );
  // #270 队列 aab6fad：PG 分片曾耗时 35.915 / 35.140 秒；源码冷计算与并行负载需要单测余量。
  // 已复用原始计算；这两条同样允许 120 秒（F-116，原 60 秒），不调整 CI 作业预算，断言与模式分流全部重跑。
  it.each(['endpoints', 'guard-inner'])(
    '%s：默认通过只警告，严格模式判红',
    (name) => {
      const stored = vi.spyOn(evidence, 'checkStored');
      const code = name === 'endpoints' ? 'REQUIRED_ENTRY_MISSING' : 'GUARD_ROLE_UNBOUND';
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const normal = check(name, false);
        expect(normal.failures).toEqual([]);
        expect(warn.mock.calls.flat().join('\n')).toContain('[证据门禁·警告]');
        expect(warn.mock.calls.flat().join('\n')).toContain(code);
        const calculated = stored.mock.calls.filter(([table]) => table === tables[name]).length;
        expect(calculated).toBeGreaterThan(0);
        const strict = check(name, true);
        expect(stored.mock.calls.filter(([table]) => table === tables[name]).length).toBe(calculated);
        expect(strict.executed).toEqual(normal.executed);
        expect(strict.failures.length).toBeGreaterThan(0);
        expect(strict.failures.map((f) => f.message).join('\n')).toContain(code);
        const local = name === 'endpoints' ? '经理入口：真实声明零发现' : '现表全部守卫内部义务';
        expect(strict.failures.some((f) => f.label.startsWith(local))).toBe(true);
        console.info(`${name}：九组局部检查默认仅警告，严格 ${strict.failures.length} 项失败`);
      } finally {
        warn.mockRestore();
      }
    },
    120_000,
  );
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

describe('AC-PRM-FW-F095 硬失败边界', () => {
  it.each([false, true])('strict=%s：未知发现码和结构错误不分流为警告', (strict) => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', strict ? '1' : '0');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fatal = ['TABLE_CONFLICT', 'UNKNOWN_CODE', 'WEAKER:scope'].map((code) => ({
      route: 'GET /fixture',
      code,
      detail: '独立硬失败反例',
    }));
    expect(registrationGate(fatal, '硬失败边界')).toEqual(fatal);
    expect(warn).not.toHaveBeenCalled();
  });
});
