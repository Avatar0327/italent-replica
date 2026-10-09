/**
 * F-075（DEC-369）“去掉前后返回完全一致”的对照支撑：每个入口跑一串固定场景，把状态码、ETag 和完整响应正文记成
 * 转录（transcript）；只规范化生成标识（UUID 按出现顺序编号）与技术时间字段（createdAt / updatedAt），其余——状态码、
 * 文案、字段、数值、业务时间——原值参与比较。**规范化后的转录**与改动前生成并提交的黄金文件逐字节相等，同时在“冗余请求
 * 的答案不同”的授权下也相等（独立性）。黄金文件只在改动前的代码上生成（F075_UPDATE_GOLDEN=1），改动后不得变化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { canonicalJson } from './route-policy/baseline.js';

export interface Step {
  readonly name: string;
  readonly status: number;
  readonly etag?: string;
  readonly body: unknown;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
/** 只有这些技术时间字段（数据库默认值生成，随运行变化）才占位；业务时间（生效日期、截止时间…）原值参与比较。 */
export const TECHNICAL_TIME_KEYS: ReadonlySet<string> = new Set(['createdAt', 'updatedAt']);

/** 一份转录内：生成标识按首次出现顺序编号，技术时间字段（createdAt / updatedAt）占位；状态码、文案、字段、数值与业务时间原样保留。 */
export function transcriptOf(steps: readonly Step[], scrub: (text: string) => string = (t) => t): unknown {
  const ids = new Map<string, number>();
  const text = (value: string) =>
    scrub(value).replace(UUID, (id) => {
      if (!ids.has(id)) ids.set(id, ids.size + 1);
      return `<id:${ids.get(id)}>`;
    });
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          text(k),
          TECHNICAL_TIME_KEYS.has(k) && typeof v === 'string' && TIMESTAMP.test(v) ? '<ts>' : walk(v),
        ]),
      );
    }
    return value;
  };
  return steps.map((s) => walk(s));
}

export async function step(name: string, response: Response): Promise<Step> {
  const etag = response.headers.get('etag') ?? undefined;
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { name, status: response.status, ...(etag ? { etag } : {}), body };
}

const GOLDEN_DIR = path.resolve(process.cwd(), 'tests/acceptance/support/f075-golden');

/** 与黄金文件逐字节比较；F075_UPDATE_GOLDEN=1 且文件不存在时才写入（只在改动前的代码上生成）。 */
export function expectGolden(name: string, steps: readonly Step[], scrub?: (text: string) => string): void {
  const file = path.join(GOLDEN_DIR, `${name}.json`);
  const actual = canonicalJson(transcriptOf(steps, scrub));
  if (process.env.F075_UPDATE_GOLDEN === '1' && !existsSync(file)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(existsSync(file), `黄金文件 ${name} 不存在：先在改动前的代码上用 F075_UPDATE_GOLDEN=1 生成`).toBe(true);
  expect(actual).toBe(readFileSync(file, 'utf8'));
}

/** 两份转录规范化后必须完全相等（独立性：冗余请求的答案不同，返回不变）。 */
export function expectSameTranscript(
  actual: readonly Step[],
  expected: readonly Step[],
  label: string,
  scrub?: (text: string) => string,
): void {
  expect(canonicalJson(transcriptOf(actual, scrub)), label).toBe(canonicalJson(transcriptOf(expected, scrub)));
}
