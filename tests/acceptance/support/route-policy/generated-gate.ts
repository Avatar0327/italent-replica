/**
 * 生成物新鲜度开关（DEC-430①，DEC-385① 落地）。
 *
 * 冻结基准（observed-contract.json、probe/<模块>.json、recorded.json）、端点计数（endpoint-counts.json）和
 * 证据登记文件（required/digests/）都由生成器从源码算出。它们曾要求每个 PR 与最新 main 逐字节一致，任何一次合并都让
 * 所有在途 PR 重合 main、手工重算。现在分两种模式：
 * - 严格（`GENERATED_STRICT=1`）：不一致即判红。CI 在 push main、定时任务，以及“PR 头已包含最新 main”
 *   （合并队列用 `pnpm merge:main` 准备好的队首 PR）时打开；
 * - 警告（默认）：断言放行，完整报告写到日志（console.warn，GitHub Actions 上另带一行 ::warning 注解）。
 *
 * 只管“提交的生成物是否等于当前源码重新生成的结果”。生成物与源码之间的正确性检查（如显式表键 = 已声明路由、
 * 声明不弱于基准）不走本开关，两种模式都判红。
 *
 * 上线前恢复每个 PR 严格（随 F-087）：CI 恒设 `GENERATED_STRICT=1`，或把 `DEFAULT_GENERATED_STRICT` 改成 true。
 * 重算命令见 docs/08_设计/DEC-430_生成物合并后重算.md。
 */
export const GENERATED_STRICT_ENV = 'GENERATED_STRICT';

/** 环境变量没设时的默认严格度。 */
export const DEFAULT_GENERATED_STRICT = false;

type Env = Readonly<Record<string, string | undefined>>;

export function generatedStrict(env: Env = process.env): boolean {
  const value = env[GENERATED_STRICT_ENV];
  if (value === undefined || value === '') return DEFAULT_GENERATED_STRICT;
  return value === '1' || value.toLowerCase() === 'true';
}

interface GateOptions {
  /** 缺省读环境变量；测试可显式传入。 */
  readonly strict?: boolean;
}

/**
 * 严格模式原样返回（调用方断言为空即判红）；警告模式输出报告并返回空数组。
 * `label` 写清是哪类生成物，报告里附重算方法，方便在 CI 日志里直接照做。
 */
export function generatedGate<T>(
  label: string,
  drift: readonly T[],
  render: (item: T) => string = String,
  options: GateOptions = {},
): T[] {
  if (options.strict ?? generatedStrict()) return [...drift];
  if (drift.length === 0) return [];
  const head =
    `[生成物·警告] ${label}：${drift.length} 项与当前源码生成结果不一致（DEC-430① PR 上只警告，` +
    `main / 队首 PR 上 ${GENERATED_STRICT_ENV}=1 判红；重算：pnpm merge:main 或按 DEC-430 文档的生成命令）`;
  console.warn([head, ...drift.map((item) => `  ${render(item)}`)].join('\n'));
  if (process.env['GITHUB_ACTIONS'] === 'true') {
    console.warn(`::warning title=生成物未重算（仅警告）::${label}：${drift.length} 项不一致，明细见本步骤日志`);
  }
  return [];
}

/** 文本生成物逐字节比较：不一致时给出一行说明（不打印整份内容）。 */
export function textDrift(name: string, generated: string, onDisk: string | undefined): string[] {
  if (onDisk === undefined) return [`${name} 缺少（应由生成器写出）`];
  return generated === onDisk ? [] : [`${name} 与生成结果不一致`];
}
