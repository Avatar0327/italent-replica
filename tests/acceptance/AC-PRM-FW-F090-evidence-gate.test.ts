/**
 * F-090（DEC-411②）：F-039 证据门禁类断言——“登记与源码不一致”——在 CI 默认只报警告、不判红；
 * `ROUTE_POLICY_EVIDENCE_STRICT=1`（或改 evidence-gate.ts 里的 DEFAULT_EVIDENCE_STRICT）恢复为硬门禁。
 * - 默认模式：注入“源码变了、登记没动”→ 门禁断言通过，但集中报告照常输出（console.warn，CI 上另带 ::warning 注解）；
 * - 严格模式：同一情况判红；
 * - 登记自身的错误（TABLE_CONFLICT、缺调用点等）和不认识的发现码，两种模式都判红（fail-closed）；
 * - 检测器本身没降级：夹具里“改源码 → EVIDENCE_STALE”仍由原有用例判红（这里只验证门禁层）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Finding } from './support/route-policy/compare.js';
import { checkEvidence, currentDigestTable, currentRegistry, repoSource } from './support/route-policy/evidence.js';
import type { SourceReader } from './support/route-policy/evidence.js';
import {
  DEFAULT_EVIDENCE_STRICT,
  DRIFT_CODES,
  EVIDENCE_STRICT_ENV,
  evidenceStrict,
  gateEvidence,
  isDriftCode,
  softGate,
} from './support/route-policy/evidence-gate.js';
import type { Evidence, RequiredTable } from './support/route-policy/required/types.js';

const FIX = 'apps/api/src/modules/fixture';
const FILES: Record<string, string> = {
  [`${FIX}/gate.ts`]: [
    "import { AppError } from '../../errors.js';",
    "import { levelOf } from './level.js';",
    'export function gate(kind: string) {',
    "  if (kind === '') throw new AppError('FORBIDDEN', '需要权限');",
    '  return levelOf(kind);',
    '}',
    '',
  ].join('\n'),
  [`${FIX}/level.ts`]: "export function levelOf(kind: string) {\n  return kind === 'a' ? 'list' : 'detail';\n}\n",
};
const CALL: Evidence = { role: 'call', unit: `${FIX}/gate.ts#gate`, anchor: "throw new AppError('FORBIDDEN'" };
const TABLE: RequiredTable = { 'GET /api/tenant/fixture': [{ perm: 'btn:Fixture#open@list', at: [CALL] }] };

const readerOf =
  (files: Record<string, string>): SourceReader =>
  (file) =>
    files[file] ?? repoSource(file);

/** 登记按原始源码生成；换读取器模拟“别的 PR 改了源码、登记没跟上”。 */
function drifted(): Finding[] {
  const original = readerOf(FILES);
  const base = {
    branch: false as const,
    digests: currentDigestTable(TABLE, original, false),
    registry: currentRegistry(TABLE, original, false),
  };
  const changed = { ...FILES, [`${FIX}/level.ts`]: FILES[`${FIX}/level.ts`]!.replace("'a'", "'b'") };
  return checkEvidence(TABLE, { ...base, read: readerOf(changed) });
}

const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);
const printed = (spy: ReturnType<typeof warnings>) => spy.mock.calls.map((call) => call.join(' ')).join('\n');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AC-PRM-FW-F090 开关：默认警告，显式打开严格模式', () => {
  it('默认是警告；ROUTE_POLICY_EVIDENCE_STRICT=1 / true 才是严格，其余值按警告', () => {
    expect(DEFAULT_EVIDENCE_STRICT).toBe(false);
    expect(EVIDENCE_STRICT_ENV).toBe('ROUTE_POLICY_EVIDENCE_STRICT');
    expect(evidenceStrict({})).toBe(false);
    expect(evidenceStrict({ ROUTE_POLICY_EVIDENCE_STRICT: '' })).toBe(false);
    expect(evidenceStrict({ ROUTE_POLICY_EVIDENCE_STRICT: '0' })).toBe(false);
    expect(evidenceStrict({ ROUTE_POLICY_EVIDENCE_STRICT: '1' })).toBe(true);
    expect(evidenceStrict({ ROUTE_POLICY_EVIDENCE_STRICT: 'true' })).toBe(true);
  });

  it('不传参数时读进程环境变量', () => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', '1');
    expect(evidenceStrict()).toBe(true);
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', '');
    expect(evidenceStrict()).toBe(false);
  });
});

describe('AC-PRM-FW-F090 分类：只有登记与源码不一致的发现码降级', () => {
  it('降级清单是显式白名单：证据漂移、账本锚点、过度声明', () => {
    expect([...DRIFT_CODES].sort()).toEqual(
      [
        'EVIDENCE_ANCHOR',
        'EVIDENCE_CLOSURE_UNRESOLVED',
        'EVIDENCE_STALE',
        'EVIDENCE_UNIT',
        'EVIDENCE_UNUSED',
        'LEGACY_DIGESTS_PRESENT',
        'PROBE_KNOWN_GAP_EVIDENCE',
        'PROBE_REDUNDANT_EVIDENCE',
      ].sort(),
    );
    expect(isDriftCode('OVERDECLARED:guard')).toBe(true);
    expect(isDriftCode('OVERDECLARED:write')).toBe(true);
  });

  it('登记自身的错误与权限弱化、路由注册完整性、不认识的码都不降级（fail-closed）', () => {
    for (const code of [
      'TABLE_CONFLICT',
      'EVIDENCE_MISSING',
      'WEAKER:object',
      'MISMATCH:identity',
      'BASELINE_MISSING',
      'ROUTE_UNDECLARED',
      'REQUIRED_MISSING',
      'SOMETHING_NEW',
    ]) {
      expect(isDriftCode(code), code).toBe(false);
    }
  });
});

describe('AC-PRM-FW-F090 默认模式：登记与源码不一致只警告', () => {
  it('夹具注入“依赖函数 levelOf 变了、登记没动”→ 检测器报 EVIDENCE_STALE；门禁层放行并输出完整报告', () => {
    const found = drifted();
    expect(found.map((f) => f.code)).toContain('EVIDENCE_STALE');
    const spy = warnings();
    expect(gateEvidence(found, '夹具', { strict: false })).toEqual([]);
    const text = printed(spy);
    expect(text).toContain('EVIDENCE_STALE');
    expect(text).toContain('levelOf'); // 集中报告的明细（变更节点）原样输出
    expect(text).toContain('夹具');
    expect(text).toContain('ROUTE_POLICY_EVIDENCE_STRICT=1'); // 提示怎么恢复硬门禁
    expect(text).not.toContain('::warning'); // 非 GitHub Actions 不带注解行
  });

  it('GitHub Actions 上另带 ::warning 注解行（单行）', () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    const spy = warnings();
    gateEvidence(drifted(), '夹具', { strict: false });
    const annotation = printed(spy)
      .split('\n')
      .filter((line) => line.startsWith('::warning'));
    expect(annotation).toHaveLength(1);
    expect(annotation[0]).toContain('夹具');
  });

  it('混合：同时有登记自身的错误 → 漂移放行，登记错误照旧判红', () => {
    const conflict: Finding = { route: 'GET /x', code: 'TABLE_CONFLICT', detail: '重复登记' };
    warnings();
    const fatal = gateEvidence([...drifted(), conflict], '夹具', { strict: false });
    expect(fatal).toEqual([conflict]);
  });

  it('没有漂移时不输出任何警告', () => {
    const spy = warnings();
    expect(gateEvidence([], '夹具', { strict: false })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('softGate：非 Finding 形态的漂移（如登记文件与源码生成物逐行比较）同样放行并输出', () => {
    const spy = warnings();
    expect(softGate('图存储', ['root-a 节点集合', 'root-b 摘要'], (item) => item, { strict: false })).toEqual([]);
    expect(printed(spy)).toContain('root-a 节点集合');
    expect(printed(spy)).toContain('root-b 摘要');
  });
});

describe('AC-PRM-FW-F090 严格模式：同一情况判红', () => {
  it('显式参数 strict:true：漂移原样返回，断言 toEqual([]) 失败', () => {
    const spy = warnings();
    const fatal = gateEvidence(drifted(), '夹具', { strict: true });
    expect(fatal.map((f) => f.code)).toContain('EVIDENCE_STALE');
    expect(() => expect(fatal).toEqual([])).toThrow();
    expect(spy).not.toHaveBeenCalled(); // 判红时由断言的失败信息承载，不重复输出警告
  });

  it('环境变量 ROUTE_POLICY_EVIDENCE_STRICT=1（不传参数）：同样判红；取消后又放行', () => {
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', '1');
    expect(gateEvidence(drifted(), '夹具').length).toBeGreaterThan(0);
    vi.stubEnv('ROUTE_POLICY_EVIDENCE_STRICT', '');
    warnings();
    expect(gateEvidence(drifted(), '夹具')).toEqual([]);
  });

  it('softGate 严格模式原样返回', () => {
    expect(softGate('图存储', ['a'], (item) => item, { strict: true })).toEqual(['a']);
  });
});
