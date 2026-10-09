/**
 * 对象 × 数据操作事实（现状必测基准，实现审第 1 轮 P2-1「保留对象 × 分支的绑定」）：在处理函数近闭包里找对象权限
 * 判定的调用点，取**实参为常量**的（对象编码字面量、模块常量、@italent/domain 常量；数据操作字面量），记为
 * `编码:操作`（动态集合如 SUBSETS[kind].objectCode 记为 `编码1|编码2|…:操作`）。实参是变量（通用枢纽内部）的
 * 调用点不记——那是枢纽自身的实现，由调用点的常量实参体现。**不读声明**。
 * 比较器要求声明的每个备选都有覆盖每条事实的对象节点（静态对象或选择器分支 × 静态操作或操作选择器分支）。
 */
import * as domain from '@italent/domain';
import path from 'node:path';
import { API_SRC, type SourceIndex } from './scan.js';

type Op = 'view' | 'create' | 'update' | 'delete';
const OPS: ReadonlySet<string> = new Set(['view', 'create', 'update', 'delete']);
const CODE = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][\w.]*$/;

/** 调用点紧挨在单分支 `if (…)` 之后：条件判定，不是无条件义务（由守卫或分支选择器登记，如 initialize 才要删除权）。 */
const CONDITIONAL = /\bif\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*(?:await\s+)?$/;

/** 从文本里取出 `fn(` 无条件调用的实参（按括号 / 引号配对切分）。 */
function callsOf(text: string, fn: string): string[][] {
  const out: string[][] = [];
  const re = new RegExp(`(?<![\\w.$])${fn}\\(`, 'g');
  for (const match of text.matchAll(re)) {
    if (CONDITIONAL.test(text.slice(Math.max(0, match.index - 160), match.index))) continue;
    const args: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    for (let i = match.index + match[0].length; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        current += ch;
        if (ch === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) {
        if (depth === 0) {
          args.push(current.trim());
          break;
        }
        depth--;
      }
      if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    out.push(args.filter((arg, i) => arg !== '' || i < args.length - 1));
  }
  return out;
}

const quoted = (arg: string | undefined) => /^'([^']*)'$/.exec(arg ?? '')?.[1];

/** 各模块 `codeOf(key)` 的对象目录（talent/access.ts、idp/access.ts）。 */
const CODE_OF: Readonly<Record<string, Readonly<Record<string, { code: string }>>>> = {
  talent: domain.TALENT_OBJECTS,
  idp: domain.IDP_OBJECTS,
};
/**
 * 人才标准的通用处理器按分派到的对象工作（routes.ts registerObject / forms）：`spec.object` 的取值域是六个人才对象，
 * 事实记为六个编码的集合（声明里该路由的对象节点覆盖其一即可）。
 */
const DISPATCHED: Readonly<Record<string, readonly string[]>> = {
  talent: Object.values(domain.TALENT_OBJECTS).map((o) => o.code),
};

/** 常量解析：字面量、模块常量（本模块目录内唯一定义）、@italent/domain 导出（含属性链与 [变量] 全集）。 */
class Resolver {
  private readonly consts = new Map<string, string>();
  constructor(
    index: SourceIndex,
    dirs: readonly string[],
    private readonly module: string,
  ) {
    const defs = new Map<string, Set<string>>();
    for (const info of index.files.values()) {
      if (!dirs.some((dir) => info.file.startsWith(dir + path.sep) || info.file === dir)) continue;
      for (const [name, init] of info.consts) {
        (defs.get(name) ?? defs.set(name, new Set()).get(name)!).add(init.getText());
      }
    }
    // 同一模块里同名常量值不唯一（各文件的 OBJECT）就不解析
    for (const [name, texts] of defs) if (texts.size === 1) this.consts.set(name, [...texts][0]!);
    // 任职模块的默认对象（employment/context.ts，readContext / requireEmploymentWrite 的缺省实参）
    const employment = index.files.get(path.join(API_SRC, 'modules/employment/context.ts'));
    const init = employment?.consts.get('EMPLOYMENT_OBJECT');
    if (init && !this.consts.has('EMPLOYMENT_OBJECT')) this.consts.set('EMPLOYMENT_OBJECT', init.getText());
  }

  codes(expr: string, depth = 0): string[] | undefined {
    const text = expr.trim();
    if (depth > 4) return undefined;
    const literal = quoted(text);
    if (literal !== undefined) return CODE.test(literal) ? [literal] : undefined;
    const codeOf = /^codeOf\('(\w+)'\)$/.exec(text);
    if (codeOf) return one(CODE_OF[this.module]?.[codeOf[1]!]?.code);
    if (text === 'spec.object' || text === 'codeOf(spec.object)') return DISPATCHED[this.module]?.slice();
    const template = /^`\$\{(\w+)\}\.(\w+)`$/.exec(text);
    if (template) {
      const prefix = this.value(template[1]!, depth);
      return typeof prefix === 'string' ? [`${prefix}.${template[2]}`] : undefined;
    }
    const value = this.value(text, depth);
    if (typeof value === 'string') return CODE.test(value) ? [value] : undefined;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string' && CODE.test(v))) return value as string[];
    return undefined;
  }

  /** 属性链求值：`A.b.c`、`A[x].code`（[变量] 取全部成员）。 */
  private value(text: string, depth: number): unknown {
    const [head = '', ...rest] = text.split(/\.(?![^[]*\])/);
    const headMatch = /^(\w+)(\[\w+\])?$/.exec(head);
    if (!headMatch) return undefined;
    const local = this.consts.get(headMatch[1]!);
    if (local) {
      if (rest.length || headMatch[2]) return undefined;
      const codes = this.codes(local, depth + 1);
      return codes && (codes.length === 1 ? codes[0] : codes);
    }
    const root = (domain as Record<string, unknown>)[headMatch[1]!];
    if (root === undefined) return undefined;
    let current: unknown[] = headMatch[2] ? Object.values(root as object) : [root];
    for (const part of rest) {
      const m = /^(\w+)(\[\w+\])?$/.exec(part);
      if (!m) return undefined;
      current = current.map((v) => (v as Record<string, unknown> | undefined)?.[m[1]!]);
      if (m[2]) current = current.flatMap((v) => Object.values((v ?? {}) as object));
    }
    if (current.some((v) => v === undefined)) return undefined;
    return current.length === 1 ? current[0] : current;
  }
}

type Extract = (
  args: string[],
  resolver: Resolver,
  text: string,
) => [string[] | undefined, string | undefined] | undefined;

/**
 * 变量操作的收窄：`if (x !== 'a' && x !== 'b') throw …` 之后 x 只能是 a / b（如人才表单的 operation 查询参数），
 * 事实记为 `a|b`（覆盖其一即可）。
 */
function narrowed(arg: string | undefined, text: string): string | undefined {
  if (!arg || !/^\w+$/.test(arg)) return undefined;
  const match = new RegExp(`if \\(${arg} !== '(\\w+)' && ${arg} !== '(\\w+)'\\)`).exec(text);
  return match && OPS.has(match[1]!) && OPS.has(match[2]!) ? `${match[1]}|${match[2]}` : undefined;
}

const TALENT_WRITE: Record<string, Op> = { create: 'create', update: 'update', delete: 'delete' };
const talentKey = (arg: string | undefined) => (arg === 'spec.object' ? 'spec.object' : quoted(arg));
const talentCodes = (key: string | undefined): string[] | undefined =>
  key === 'spec.object'
    ? DISPATCHED['talent']?.slice()
    : one(key ? domain.TALENT_OBJECTS[key as never]?.['code'] : undefined);
const idpCode = (key: string | undefined) =>
  key ? (domain.IDP_OBJECTS as Record<string, { code: string }>)[key]?.code : undefined;
const one = (code: string | undefined) => (code ? [code] : undefined);
/** 第 i 个实参是数据操作字面量；缺省（或 undefined）取 fallback；是变量则无法判定。 */
function opAt(args: string[], i: number, fallback?: Op): Op | undefined {
  const arg = args[i];
  if (arg === undefined || arg === 'undefined') return fallback;
  const value = quoted(arg);
  return value && OPS.has(value) ? (value as Op) : undefined;
}

const SHAPES: readonly { fn: string; modules?: readonly string[]; extract: Extract }[] = [
  {
    fn: 'requirePermission',
    extract: (args, r) => {
      const request = args[1] ?? '';
      const action = /action:\s*'object\.(view|create|update|delete)'/.exec(request)?.[1] as Op | undefined;
      const resource = /resource:\s*([^,}]+)/.exec(request)?.[1];
      return action && resource ? [r.codes(resource), action] : undefined;
    },
  },
  { fn: 'objectContext', extract: (args, r) => [r.codes(args[2] ?? ''), opAt(args, 3, 'view')] },
  { fn: 'writeFields', extract: (args, r) => [r.codes(args[2] ?? ''), opAt(args, 3)] },
  { fn: 'access', modules: ['personnel'], extract: (args, r) => [r.codes(args[2] ?? ''), opAt(args, 3)] },
  {
    fn: 'talentContext',
    modules: ['talent'],
    extract: (args) => [talentCodes(talentKey(args[2])), opAt(args, 3, 'view')],
  },
  {
    fn: 'talentWriteContext',
    modules: ['talent'],
    extract: (args, _r, text) => [
      talentCodes(talentKey(args[2])),
      TALENT_WRITE[quoted(args[3]) ?? ''] ?? narrowed(args[3], text),
    ],
  },
  { fn: 'idpContext', modules: ['idp'], extract: (args) => [one(idpCode(quoted(args[2]))), opAt(args, 3, 'view')] },
  { fn: 'idpWriteContext', modules: ['idp'], extract: (args) => [one(idpCode(quoted(args[2]))), opAt(args, 3)] },
  {
    // employment/context.ts readContext(c, deps, action, revision?, resource?, objectCode = EMPLOYMENT_OBJECT)
    fn: 'readContext',
    modules: ['employment'],
    extract: (args, r) => {
      const op = /^'object\.(view|create|update|delete)'$/.exec(args[2] ?? '')?.[1] as Op | undefined;
      return [r.codes(args[5] ?? 'EMPLOYMENT_OBJECT'), op];
    },
  },
  {
    // requireEmploymentWrite(ctx, operation, payload, button?, objectCode = EMPLOYMENT_OBJECT)；自助模块经叠加授权器
    // （selfAccess）判定，由 self 声明覆盖，不在这里记
    fn: 'requireEmploymentWrite',
    modules: ['employment'],
    extract: (args, r) => [r.codes(args[4] ?? 'EMPLOYMENT_OBJECT'), opAt(args, 1)],
  },
  {
    // org/routes.ts context(c, deps, 'read' | 'create' | 'update' | 'delete')：组织对象（OBJECT）
    fn: 'context',
    modules: ['org'],
    extract: (args, r) => {
      const action = quoted(args[2]);
      const op = action === 'read' ? 'view' : action && OPS.has(action) ? (action as Op) : undefined;
      return [r.codes('OBJECT'), op];
    },
  },
];

/**
 * `const ok = await deps.authorize({ …, action: 'object.<op>', resource: X }); if (!ok) throw …`：
 * 等同 requirePermission。
 */
const AUTHORIZE_THEN_THROW = /const (\w+) = await deps\.authorize\(\{([^{}]*)\}\);\s*if \(!\1\) throw\b/g;

/**
 * 360 的 need（context.ts read / write 的对象 × 操作）：`{ need: { object: 'person', operation: 'update' … } }` 与
 * `VIEW / EDIT = { object: 'activity' … }` 常量；操作缺省为查看。`also` / 引用列表里的 need（`[{ need: … }]`）是
 * 附带对象，由守卫 survey360.alsoObjects 承载，不在这里记。
 */
function survey360Needs(text: string): string[] {
  const objects = domain.survey360.SURVEY360_OBJECTS as Record<string, { code: string }>;
  const out: string[] = [];
  const shapes = [
    /(?<!\[\s*)\{\s*need:\s*\{\s*object:\s*'(\w+)'(?:,\s*operation:\s*'(\w+)')?/g,
    /\b[A-Z][A-Z0-9_]* = \{\s*object:\s*'(\w+)'(?:,\s*operation:\s*'(\w+)')?/g,
  ];
  for (const re of shapes) {
    for (const match of text.matchAll(re)) {
      const code = objects[match[1]!]?.code;
      const op = match[2] ?? 'view';
      if (code && OPS.has(op)) out.push(`${code}:${op}`);
    }
  }
  return out;
}

/** 近闭包文本 → `编码(|编码…):操作` 事实（排序去重）。 */
export function objectFacts(index: SourceIndex, near: string, module: string, dirs: readonly string[]): string[] {
  const resolver = new Resolver(index, dirs, module);
  const facts = new Set<string>();
  if (module === 'survey360') for (const fact of survey360Needs(near)) facts.add(fact);
  for (const match of near.matchAll(AUTHORIZE_THEN_THROW)) {
    const action = /action:\s*'object\.(view|create|update|delete)'/.exec(match[2]!)?.[1];
    const resource = /resource:\s*([^,]+?)\s*(?:,|$)/.exec(match[2]!)?.[1];
    const codes = resource ? resolver.codes(resource) : undefined;
    if (action && codes?.length) facts.add(`${[...new Set(codes)].sort().join('|')}:${action}`);
  }
  for (const shape of SHAPES) {
    if (shape.modules && !shape.modules.includes(module)) continue;
    for (const args of callsOf(near, shape.fn)) {
      const [codes, op] = shape.extract(args, resolver, near) ?? [];
      if (codes?.length && op) facts.add(`${[...new Set(codes)].sort().join('|')}:${op}`);
    }
  }
  return [...facts].sort();
}
