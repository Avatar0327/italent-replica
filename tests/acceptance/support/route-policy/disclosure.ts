/**
 * 准入事实与披露事实的区分（实现审第 2 轮 P2-1 残项）：处理函数里**不抛错**的权限求值只决定响应里的附加披露
 * （canEdit / canApply、接收行、组织字段、交接改派范围…），对应声明的 optional；抛错的判定才是准入。
 * 规则只看语法形状，不读声明：
 * - R1 吞掉 FORBIDDEN 的 try / catch：catch 里只有一句“不是 FORBIDDEN 就重抛”（catch 里另有判定的是“或”关系，
 *   如人才候选的新建权 / 编辑权，不算）；
 * - R2 `const x = await <求值>(…)` 之后没有紧跟 `if (!x) throw`，或求值结果直接作对象字面量的属性值
 *   （`canX: await <求值>(…)`）。求值 = deps.authorize / authorizeInTransaction(…) / adminScope，以及**布尔授权函数**
 *   （函数体就是 `return !!(await deps.authorize(…))` 一类，scan.ts booleanEvaluators）——这类函数按**调用点**判定：
 *   `if (!(await f(…))) throw` 是准入（函数体照常展开进准入闭包），上面两种用法才是披露（实现审第 3 轮：
 *   managerHasHr 在经理入口生成 canViewReporting 是披露，在汇报关系页为假即 403 是准入）；
 * - R3 辅助函数里 `if (!(await deps.authorize(…))) { return …`：以“无权值”提前返回，函数余下部分只为有权时补充
 *   披露（如候选里的组织字段），整段到函数末尾都算披露；处理函数本身不按此剥离。
 * scan.ts 在闭包展开时按片段切分：披露片段里引用的函数只进披露闭包。准入闭包给原语扫描；完整闭包多出来的维度 /
 * 对象事实记为披露事实。
 */

/** 从 open（指向开括号）起找到配对的闭括号下标；字符串里的括号不计。 */
function matching(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

type Span = readonly [number, number];

/** R1：吞掉 FORBIDDEN 的 try 块。 */
function swallowedTries(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/\btry\s*\{/g)) {
    const end = matching(text, match.index + match[0].length - 1);
    if (end < 0) continue;
    const handler = /^\s*catch\s*\(\s*(\w+)\s*\)\s*\{/.exec(text.slice(end + 1));
    if (!handler) continue;
    const catchOpen = end + 1 + handler[0].length - 1;
    const catchEnd = matching(text, catchOpen);
    if (catchEnd < 0) continue;
    const body = text.slice(catchOpen + 1, catchEnd).trim();
    const only = new RegExp(`^if \\([^;]*${handler[1]}\\.code !== 'FORBIDDEN'\\) throw ${handler[1]};?$`);
    if (only.test(body)) {
      spans.push([match.index, catchEnd + 1]);
    }
  }
  return spans;
}

const BUILTIN_EVALUATORS = ['deps\\.authorize', 'authorizeInTransaction\\([^()]*\\)', 'adminScope'];

function evaluatorPattern(evaluators: ReadonlySet<string>): string {
  return [...BUILTIN_EVALUATORS, ...[...evaluators].map((name) => name.replace(/[$]/g, '\\$'))].join('|');
}

/** R2：`const x = await <求值>(…)` 之后没有紧跟 `if (!x) throw`；`key: await <求值>(…)` 对象字面量属性值。 */
function unenforcedEvaluations(text: string, evaluators: ReadonlySet<string>): Span[] {
  const spans: Span[] = [];
  const pattern = evaluatorPattern(evaluators);
  for (const match of text.matchAll(new RegExp(`const (\\w+) = await (?:${pattern})\\(`, 'g'))) {
    const end = matching(text, match.index + match[0].length - 1);
    if (end < 0) continue;
    const rest = text.slice(end + 1);
    if (new RegExp(`^\\s*;?\\s*if \\(!${match[1]}\\) throw\\b`).test(rest)) continue;
    spans.push([match.index, end + 1]);
  }
  for (const match of text.matchAll(new RegExp(`[{,]\\s*\\w+:\\s*await (?:${pattern})\\(`, 'g'))) {
    const end = matching(text, match.index + match[0].length - 1);
    if (end >= 0) spans.push([match.index + 1, end + 1]);
  }
  return spans;
}

/** R3：辅助函数里 `if (!(await deps.authorize(…)))` 之后是 return：从这里到函数末尾都算披露。 */
function earlyReturns(text: string, handler: boolean): Span[] {
  if (handler) return [];
  for (const match of text.matchAll(/\bif \(!\(await deps\.authorize\(/g)) {
    const end = matching(text, match.index + 3);
    if (end < 0) continue;
    if (/^\s*(\{\s*)?return\b/.test(text.slice(end + 1))) return [[match.index, text.length]];
  }
  return [];
}

export interface Split {
  /** 剥掉披露片段后的文本（准入原语在这里扫描）。 */
  readonly admission: string;
  /** 被剥掉的披露片段。 */
  readonly disclosure: string;
}

/** `handler`：文本是路由处理函数本身（R3 不适用）；`evaluators`：布尔授权函数名（按调用点判定）。 */
export function splitDisclosure(text: string, handler = false, evaluators: ReadonlySet<string> = new Set()): Split {
  const spans = [
    ...swallowedTries(text),
    ...unenforcedEvaluations(text, evaluators),
    ...earlyReturns(text, handler),
  ].sort((a, b) => a[0] - b[0]);
  let admission = '';
  const disclosure: string[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue; // 嵌套在已剥离片段里的
    admission += text.slice(cursor, start);
    disclosure.push(text.slice(start, end));
    cursor = end;
  }
  admission += text.slice(cursor);
  return { admission, disclosure: disclosure.join('\n') };
}
