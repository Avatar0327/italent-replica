/**
 * 计算公式的字段引用按 ID 绑定（F-082，契约 §1.4～§1.7，DEC-373②、DEC-376）：
 * - bindFormula：输入文本里的 `盘点对象.<名>` → 规范文本里的 ID 句柄 `@{tr-field:<uuid>}`，并逐处核对绑定证明；
 * - renderFormula：规范文本 → 查看人看到的名称文本，同时给出逐处绑定（`formulaBindings`）。
 * 纯函数：不读库、不取锁；字段目录（对提交人 / 查看人可见的字段）与目录版本由调用方给出。
 * 渲染与绑定都在**词法单元 / 语法树节点**上按源码区间进行，禁止对公式整段做正则或子串替换（#184 P2-08a 的教训）。
 */
import {
  HIDDEN_FIELD_PLACEHOLDER,
  fieldHandle,
  parseFormula,
  parseStoredFormula,
  validateFormula,
  walk,
  type ExprNode,
  type FieldNode,
  type SyntaxIssue,
  type SyntaxIssueCode,
} from '../expression/index.js';
import { FORMULA_CONTEXT_FIELDS, FORMULA_OBJECT } from './calc-rule.js';

/** 逐处绑定里“项目上下文”的记号（`盘点对象.盘点方案` 指项目 / 方案，不是字段）。 */
export const CONTEXT_BINDING = 'context';
export type ReferenceBinding = string;
/** `盘点对象.盘点方案` 同时是项目上下文路径和可能被租户建出的自定义字段名。 */
const RESERVED_NAME = '盘点方案';
const RESERVED_PATH = `${FORMULA_OBJECT}.${RESERVED_NAME}`;

export interface BindFormulaField {
  readonly id: string;
  readonly name: string;
}

export interface BindFormulaOptions {
  /** 对提交人可见的字段（name / kind / enabled / systemWritten 四列都可见，且在字段目录范围内）；允许重名。 */
  readonly visibleFields: readonly BindFormulaField[];
  /**
   * 绑定证明 `formulaBindings`：第 k 处 `盘点对象.*` 引用 → 字段 ID / `"context"` / `null`（新输入）。
   * 不带等同于全部为 null。
   */
  readonly proofs?: readonly (string | null)[] | undefined;
  /** 字段目录版本：新输入的引用（证明为空）要求提交的版本等于当前版本；缺少 catalogVersion 时按不一致处理。 */
  readonly catalogVersion?: { readonly current: number; readonly submitted: number | undefined } | undefined;
}

export type BindIssueCode =
  SyntaxIssueCode | 'BARE_WORD' | 'HIDDEN_FIELD' | 'BINDING_MISMATCH' | 'RESERVED_PATH_AMBIGUOUS';

export interface BindIssue {
  readonly code: BindIssueCode;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  /** 第几处 `盘点对象.*` 引用（从 0 起，按源码顺序，含占位符）。 */
  readonly occurrence?: number;
  /** RESERVED_PATH_AMBIGUOUS：可选的绑定（`"context"` 与各同名可见字段 ID）。 */
  readonly choices?: readonly string[];
}

export type BindFailure =
  /** 400 FORMULA_INVALID：语法、函数、未知字段、裸词、占位符、证明数量不符、盘点方案需显式选择。 */
  | { readonly code: 'FORMULA_INVALID'; readonly issues: readonly BindIssue[] }
  /** 409：带 ID 的引用，字段当前名称与公式里写的不一致（已改名或被换绑）。 */
  | { readonly code: 'CALC_BINDING_STALE'; readonly occurrence: number }
  /** 409：新输入的引用，提交的字段目录版本不是当前版本。 */
  | { readonly code: 'FIELD_CATALOG_CHANGED' }
  /** 400：新输入的引用遇到同名的多个可见字段。 */
  | { readonly code: 'CALC_FIELD_NAME_AMBIGUOUS'; readonly occurrence: number };

export type BindResult =
  | {
      readonly ok: true;
      /** 规范文本：每个绑定的字段引用换成句柄，其余字符原样保留。 */
      readonly stored: string;
      /** 逐处映射：字段 ID 或 `"context"`，按 `盘点对象.*` 引用的出现顺序。 */
      readonly mapping: readonly ReferenceBinding[];
      /** 引用到的字段 ID（去重，按出现顺序）。 */
      readonly fieldIds: readonly string[];
      /** 是否有按名称解析的新输入引用（已核对字段目录版本）。 */
      readonly hasNewInput: boolean;
    }
  | { readonly ok: false; readonly failure: BindFailure };

const invalid = (...issues: BindIssue[]): BindResult => ({
  ok: false,
  failure: { code: 'FORMULA_INVALID', issues },
});
const fromSyntax = (issue: SyntaxIssue): BindIssue => ({
  code: issue.code,
  message: issue.message,
  line: issue.line,
  column: issue.column,
});
const at = (node: { readonly pos: { readonly line: number; readonly column: number } }) => ({
  line: node.pos.line,
  column: node.pos.column,
});

/** 盘点字段引用：`盘点对象.<一段名字>`（含占位符）；更深的路径、其他对象前缀不属于它。 */
const isObjectReference = (node: FieldNode) => node.path.length === 2 && node.path[0] === FORMULA_OBJECT;
/** 以“盘点对象”开头的任何路径（含三段及更深的非规范写法）。 */
const startsWithObject = (node: FieldNode) => node.fieldId === undefined && node.path[0] === FORMULA_OBJECT;

function fieldNodes(program: { definitions: readonly { value: ExprNode }[]; body: ExprNode }): FieldNode[] {
  const found: FieldNode[] = [];
  const visit = (node: ExprNode) => {
    if (node.type === 'field') found.push(node);
  };
  for (const definition of program.definitions) walk(definition.value, visit);
  walk(program.body, visit);
  return found.sort((a, b) => a.pos.offset - b.pos.offset);
}

/**
 * 裸词（DEC-374⑥）：单段标识符，既不是先前 Def 定义的变量，也不是函数调用名（调用名在语法树里是 call 节点，不是标识符）。
 * 变量只在其 Def 之后可用（与保存校验的 ReferenceCollector 同一规则）。
 */
function bareWords(program: { definitions: readonly { name: string; value: ExprNode }[]; body: ExprNode }) {
  const defined = new Set<string>();
  const found: { name: string; node: ExprNode }[] = [];
  const visit = (node: ExprNode) => {
    if (node.type === 'identifier' && !defined.has(node.name)) found.push({ name: node.name, node });
  };
  for (const definition of program.definitions) {
    walk(definition.value, visit);
    defined.add(definition.name);
  }
  walk(program.body, visit);
  return found.sort((a, b) => a.node.pos.offset - b.node.pos.offset);
}

/** 输入模式下引擎不报“未知字段”的路径：裸词（另行判定）、项目 / 活动固定字段、`盘点对象.<名>`（逐处绑定）。 */
const acceptedByEngine = (path: string) =>
  !path.includes('.') ||
  path in FORMULA_CONTEXT_FIELDS ||
  (path.startsWith(`${FORMULA_OBJECT}.`) && !path.slice(FORMULA_OBJECT.length + 1).includes('.'));

const normalizeId = (id: string) => id.toLowerCase();

/** 先于 HIDDEN_FIELD 报告的前置检查：语法、函数是否存在、参数个数（契约 §1.5）；参数类型等语义问题排在它之后（§1.6）。 */
const PRECHECK_CODES: ReadonlySet<string> = new Set([
  'SYNTAX_ERROR',
  'CHINESE_QUOTE',
  'UNKNOWN_FUNCTION',
  'ARGUMENT_COUNT',
]);

/** 把输入文本里的字段引用绑定成 ID（契约 §1.5）。第一个失败即返回；语法正确时 HIDDEN_FIELD 优先于其他语义问题（§1.6）。 */
export function bindFormula(source: string, options: BindFormulaOptions): BindResult {
  const parsed = parseFormula(source, { placeholders: true });
  if (!parsed.ok) return invalid(fromSyntax(parsed.errors[0]!));
  const checked = validateFormula(source, { isKnownField: acceptedByEngine, placeholders: true });
  const engineErrors = checked.ok ? [] : checked.errors;
  const precheck = engineErrors.filter((error) => PRECHECK_CODES.has(error.code));
  if (precheck.length > 0) return invalid(...precheck.map(fromSyntax));

  const references = fieldNodes(parsed.program).filter(isObjectReference);
  const hidden = references.flatMap((node, occurrence) => (node.hidden ? [{ node, occurrence }] : []));
  if (hidden.length > 0) {
    const message = '公式里有你看不到的字段，只能原样保留或整段重写；如页面已过期请刷新';
    return invalid(
      ...hidden.map(({ node, occurrence }) => ({ code: 'HIDDEN_FIELD' as const, message, occurrence, ...at(node) })),
    );
  }
  const { proofs } = options;
  if (proofs !== undefined && proofs.length !== references.length) {
    return invalid({ code: 'BINDING_MISMATCH', message: '公式里的字段绑定与引用处数不一致，请刷新后重新编辑' });
  }
  const later = engineErrors.filter((error) => !PRECHECK_CODES.has(error.code));
  const semantic = semanticIssues(parsed.program, later, options.visibleFields);
  if (semantic.length > 0) return invalid(...semantic);
  return resolveReferences(source, references, options);
}

/** 引擎报的未知字段（其他对象前缀、过深路径）与裸词，按源码位置排序。 */
function semanticIssues(
  program: Parameters<typeof bareWords>[0],
  engineErrors: readonly SyntaxIssue[],
  visible: readonly BindFormulaField[],
): BindIssue[] {
  const unknown = engineErrors.map(fromSyntax);
  const bare = bareWords(program).map(({ name, node }): BindIssue => {
    // 与看不到的字段同名时不提示，避免暴露不可见字段的存在
    const hint = visible.some((field) => field.name === name) ? `；引用盘点字段请写 ${FORMULA_OBJECT}.${name}` : '';
    return {
      code: 'BARE_WORD',
      message: `“${name}”不是字段也不是变量；作文本请写成 "${name}"${hint}`,
      ...at(node),
    };
  });
  const position = (issue: BindIssue) => (issue.line ?? 0) * 1_000_000 + (issue.column ?? 0);
  return [...unknown, ...bare].sort((a, b) => position(a) - position(b));
}

function resolveReferences(source: string, references: readonly FieldNode[], options: BindFormulaOptions): BindResult {
  const byId = new Map(options.visibleFields.map((field) => [normalizeId(field.id), field]));
  const mapping: (string | undefined)[] = references.map(() => undefined);
  const unknownField = (node: FieldNode, occurrence: number): BindResult =>
    // 不存在、跨租户、对提交人不可见都是同一个结果，不泄露
    invalid({ code: 'UNKNOWN_FIELD', message: `找不到字段或变量 ${node.text}`, occurrence, ...at(node) });

  // 1. 带证明的引用，按出现顺序：字段 ID 要对得上当前名称，"context" 只对盘点方案有效
  for (const [occurrence, node] of references.entries()) {
    const proof = options.proofs?.[occurrence] ?? null;
    if (proof === null) continue;
    if (proof === CONTEXT_BINDING) {
      if (node.path[1] !== RESERVED_NAME) {
        return invalid({ code: 'BINDING_MISMATCH', message: '该引用不能绑定到项目上下文', occurrence, ...at(node) });
      }
      mapping[occurrence] = CONTEXT_BINDING;
      continue;
    }
    const field = byId.get(normalizeId(proof));
    if (!field) return unknownField(node, occurrence);
    if (field.name !== node.path[1]) return { ok: false, failure: { code: 'CALC_BINDING_STALE', occurrence } };
    mapping[occurrence] = field.id;
  }

  // 2. 新输入的引用：先核对字段目录版本，再按名称解析
  const fresh = references.flatMap((node, occurrence) =>
    mapping[occurrence] === undefined ? [{ node, occurrence }] : [],
  );
  const version = options.catalogVersion;
  if (fresh.length > 0 && (!version || version.submitted !== version.current)) {
    return { ok: false, failure: { code: 'FIELD_CATALOG_CHANGED' } };
  }
  for (const { node, occurrence } of fresh) {
    const name = node.path[1]!;
    const same = options.visibleFields.filter((field) => field.name === name);
    if (name === RESERVED_NAME) {
      if (same.length === 0) {
        mapping[occurrence] = CONTEXT_BINDING;
        continue;
      }
      // DEC-376③：有可见的同名自定义字段时要求显式选择，前端据此弹出选择后重提
      const choices = [CONTEXT_BINDING, ...same.map((field) => field.id)];
      return invalid({
        code: 'RESERVED_PATH_AMBIGUOUS',
        message: '“盘点方案”既是项目上下文，也是自定义字段的名称，请选择要引用的对象',
        occurrence,
        choices,
        ...at(node),
      });
    }
    if (same.length === 0) return unknownField(node, occurrence);
    if (same.length > 1) return { ok: false, failure: { code: 'CALC_FIELD_NAME_AMBIGUOUS', occurrence } };
    mapping[occurrence] = same[0]!.id;
  }

  const resolved = mapping as string[];
  return {
    ok: true,
    stored: canonicalText(source, references, resolved),
    mapping: resolved,
    fieldIds: [...new Set(resolved.filter((entry) => entry !== CONTEXT_BINDING))],
    hasNewInput: fresh.length > 0,
  };
}

/** 把每个引用的源码区间换成句柄（或规范的上下文路径），其余字符原样保留。 */
function canonicalText(source: string, references: readonly FieldNode[], mapping: readonly string[]): string {
  let text = '';
  let cursor = 0;
  for (const [index, node] of references.entries()) {
    const binding = mapping[index]!;
    text += source.slice(cursor, node.pos.offset);
    text += binding === CONTEXT_BINDING ? RESERVED_PATH : fieldHandle(binding);
    cursor = node.end;
  }
  return text + source.slice(cursor);
}

export type FormulaBindingState = 'bound' | 'legacy' | 'unresolved';

export interface RenderFormulaOptions {
  /** 计算项目的存储形态（`formula_binding`）：bound 存规范文本，legacy / unresolved 存原来的名称文本，渲染规则不同。 */
  readonly binding: FormulaBindingState;
  /** 查看人可见的字段（允许重名）；不在其中的字段渲染成占位符。 */
  readonly visibleFields: readonly BindFormulaField[];
  /** legacy / unresolved 整段无法解析时：只有“全部字段都可见”的查看人看原文，其他人只看到固定提示。 */
  readonly allFieldsVisible?: boolean;
}

export type RenderResult =
  | {
      readonly ok: true;
      /**
       * 渲染文本：bound 的句柄 → `盘点对象.<当前名称>`，看不到的字段 → `盘点对象.〔不可见字段〕`，项目上下文路径原样；
       * legacy / unresolved 的 `盘点对象.<名>` 只有可见字段里存在同名字段才原样显示，否则换成占位符。
       */
      readonly text: string;
      /**
       * 逐处绑定：bound 时可见字段为其 ID、项目上下文为 `"context"`、占位符为 `null`；
       * legacy / unresolved 一律为 `null`（没有确定绑定，不能作为绑定证明）。
       */
      readonly bindings: readonly (string | null)[];
      /** legacy / unresolved 整段无法解析（需要管理员修复公式）。 */
      readonly repairNeeded?: true;
    }
  /** bound 的规范文本损坏（无法解析，或残留名称写法）：不原样输出。 */
  | { readonly ok: false };

/** 整段无法解析的 legacy 公式对无权看全部字段的查看人显示的固定提示。 */
export const FORMULA_REPAIR_NOTICE = '〔公式待修复，无法显示〕';

/** 渲染计算项目的公式（契约 §1.4）：先看存储形态，再按对应规则渲染，不把 legacy 当作 bound。 */
export function renderFormula(stored: string, options: RenderFormulaOptions): RenderResult {
  return options.binding === 'bound' ? renderBound(stored, options) : renderLegacy(stored, options);
}

function renderBound(stored: string, options: RenderFormulaOptions): RenderResult {
  const parsed = parseStoredFormula(stored);
  if (!parsed.ok) return { ok: false };
  const names = new Map(options.visibleFields.map((field) => [field.id.toLowerCase(), field.name]));
  const bindings: (string | null)[] = [];
  let text = '';
  let cursor = 0;
  for (const node of fieldNodes(parsed.program).filter((n) => n.fieldId !== undefined || startsWithObject(n))) {
    text += stored.slice(cursor, node.pos.offset);
    cursor = node.end;
    if (node.fieldId !== undefined) {
      const name = names.get(node.fieldId);
      text += `${FORMULA_OBJECT}.${name ?? HIDDEN_FIELD_PLACEHOLDER}`;
      bindings.push(name === undefined ? null : node.fieldId);
    } else if (node.text === RESERVED_PATH) {
      text += RESERVED_PATH;
      bindings.push(CONTEXT_BINDING);
    } else {
      // bound 的规范文本里只会有句柄和固定的 盘点对象.盘点方案：任何以“盘点对象”开头的其他路径（名称写法、三段及更深）
      // 都是数据损坏，宁可不显示也不原样输出可能不可见的名称
      return { ok: false };
    }
  }
  return { ok: true, text: text + stored.slice(cursor), bindings };
}

function renderLegacy(stored: string, options: RenderFormulaOptions): RenderResult {
  const parsed = parseFormula(stored);
  if (!parsed.ok) {
    const text = options.allFieldsVisible === true ? stored : FORMULA_REPAIR_NOTICE;
    return { ok: true, text, bindings: [], repairNeeded: true };
  }
  const visibleNames = new Set(options.visibleFields.map((field) => field.name));
  const bindings: (string | null)[] = [];
  let text = '';
  let cursor = 0;
  for (const node of fieldNodes(parsed.program).filter(startsWithObject)) {
    text += stored.slice(cursor, node.pos.offset);
    cursor = node.end;
    // 契约 §1.4：只有查看人可见字段里存在同名字段才原样显示（“盘点方案”也一样，没有固定路径例外）；
    // 字段名可以含“.”（B5 允许），所以按“盘点对象.”之后的整段名称判断，不按段数；只有前缀可见不算。证明一律为 null，由用户显式选择
    const shown = node.path.length > 1 && visibleNames.has(node.path.slice(1).join('.'));
    text += shown ? stored.slice(node.pos.offset, node.end) : `${FORMULA_OBJECT}.${HIDDEN_FIELD_PLACEHOLDER}`;
    bindings.push(null);
  }
  return { ok: true, text: text + stored.slice(cursor), bindings };
}
