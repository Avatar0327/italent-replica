/**
 * 证据门禁的严格度开关（F-090，DEC-411②）。
 *
 * “登记与源码不一致”这一类断言（证据摘要 / 依赖图过期、锚点或单元对不上、登记没被引用、账本证据锚点失效、
 * 过度声明）曾让每个合并都连带打红在途 PR。现在默认只警告：断言放行，但完整报告照常写到 CI 日志（console.warn，
 * GitHub Actions 上另带一行 ::warning 注解）。
 *
 * 恢复硬门禁（F-087 上线前做）：
 * - 环境变量 `ROUTE_POLICY_EVIDENCE_STRICT=1`（本地和 CI 都可显式打开）；
 * - 或把下面的 `DEFAULT_EVIDENCE_STRICT` 改成 `true`（改默认值，所有环境生效）。
 *
 * 不降级：登记自身的错误（TABLE_CONFLICT、缺调用点等）、权限弱化（WEAKER:* / MISMATCH:*）、路由注册完整性、
 * 业务行为断言，以及不认识的发现码——只有下面 `DRIFT_CODES` 白名单里的才降级（fail-closed）。
 */
import type { Finding } from './compare.js';

export const EVIDENCE_STRICT_ENV = 'ROUTE_POLICY_EVIDENCE_STRICT';

/** 环境变量没设时的默认严格度。F-087 恢复硬门禁时可直接改成 true。 */
export const DEFAULT_EVIDENCE_STRICT = false;

type Env = Readonly<Record<string, string | undefined>>;

export function evidenceStrict(env: Env = process.env): boolean {
  const value = env[EVIDENCE_STRICT_ENV];
  if (value === undefined || value === '') return DEFAULT_EVIDENCE_STRICT;
  return value === '1' || value.toLowerCase() === 'true';
}

/** 降级的发现码：都是“登记（摘要、图、锚点、账本）与当前源码对不上”，修法是复核后重新生成登记。 */
export const DRIFT_CODES: ReadonlySet<string> = new Set([
  'EVIDENCE_STALE', // 证据单元或依赖的摘要、依赖图、绑定指纹过期（集中报告）
  'EVIDENCE_ANCHOR', // 锚点不在所指单元里
  'EVIDENCE_UNIT', // 证据单元在源码里找不到
  'EVIDENCE_CLOSURE_UNRESOLVED', // 依赖闭包里有解析不了的项
  'EVIDENCE_UNUSED', // 登记了却没被引用
  'LEGACY_DIGESTS_PRESENT', // 旧的平铺 digests.ts 回来了
  'PROBE_KNOWN_GAP_EVIDENCE', // 已知缺口账本的证据锚点失效
  'PROBE_REDUNDANT_EVIDENCE', // 冗余观测账本的证据锚点失效
]);

/** 过度声明（声明多于现状）同属“登记与源码不一致”；弱化（WEAKER:*）和身份不符（MISMATCH:*）不在内。 */
export const isDriftCode = (code: string): boolean => DRIFT_CODES.has(code) || code.startsWith('OVERDECLARED:');

interface GateOptions {
  /** 缺省读环境变量；测试可显式传入。 */
  readonly strict?: boolean;
}

function announce<T>(label: string, drift: readonly T[], render: (item: T) => string): void {
  if (drift.length === 0) return;
  const head = `[证据门禁·警告] ${label}：${drift.length} 项登记与源码不一致（F-090 默认只警告，未判红；${EVIDENCE_STRICT_ENV}=1 恢复硬门禁）`;
  console.warn([head, ...drift.map(render)].join('\n'));
  if (process.env['GITHUB_ACTIONS'] === 'true') {
    console.warn(`::warning title=证据门禁（仅警告）::${label}：${drift.length} 项登记与源码不一致，明细见本步骤日志`);
  }
}

/**
 * 软门禁：严格模式原样返回（调用方断言为空即判红）；警告模式输出报告并返回空数组。
 * 用于不是 Finding 形态的漂移（如登记文件与当前源码生成物逐行比较）。
 */
export function softGate<T>(
  label: string,
  drift: readonly T[],
  render: (item: T) => string = String,
  options: GateOptions = {},
): T[] {
  if (options.strict ?? evidenceStrict()) return [...drift];
  announce(label, drift, render);
  return [];
}

const show = (finding: Finding): string => `  ${finding.route} ${finding.code}: ${finding.detail}`;

/** 把一次检查的发现分流：漂移类走软门禁，其余（登记自身错误、权限弱化、不认识的码）原样返回，两种模式都判红。 */
export function gateEvidence(findings: readonly Finding[], label: string, options: GateOptions = {}): Finding[] {
  const fatal = findings.filter((finding) => !isDriftCode(finding.code));
  const drift = findings.filter((finding) => isDriftCode(finding.code));
  return [...fatal, ...softGate(label, drift, show, options)];
}
