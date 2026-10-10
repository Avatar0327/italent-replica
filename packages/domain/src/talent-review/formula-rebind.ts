/**
 * 存量公式改绑的领域规则（F-082 契约 §6.1～§6.3，DEC-376③⑥）：把 legacy / unresolved 的名称文本按**迁移时 B5 的解析规则**
 * 固定绑定成规范文本，不按新规则重新解释——
 * - 字段目录用全部字段（系统执行，不按查看人）；`盘点对象.<名>` 恰有 1 个同名字段 → 绑定；
 * - `盘点对象.盘点方案`：有 1 个名为“盘点方案”的自定义字段 → 绑定该字段（B5 自定义字段优先），没有 → 项目上下文，
 *   多于 1 个 → 冲突（B5 此时退到上下文，这里视为冲突、不猜）。
 * 失败时给出原因码（binding_issue）与候选字段（宁可多保护）：能解析 → 每处引用在当时全部同名字段的 ID；整段解析失败 →
 * 与删除守卫文本兜底同一口径（名称粗筛命中）。纯函数：不读库、不取锁。
 */
import { parseFormula } from '../expression/index.js';
import { type FormulaField, textMentionsField } from './calc-rule.js';
import {
  bindFormula,
  CONTEXT_BINDING,
  fieldNodes,
  isObjectReference,
  RESERVED_NAME,
  startsWithObject,
} from './formula-binding.js';
import { checkRenameRoundTrip } from './formula-rename.js';

/** binding_issue 的原因码（契约 §6.3）。 */
export type RebindIssue =
  | 'UNKNOWN_FIELD'
  | 'AMBIGUOUS_FIELD'
  | 'RESERVED_PATH_CONFLICT'
  | 'BARE_WORD'
  | 'INVALID'
  | 'MULTI_OPTION'
  | 'INPUT_LIMIT';

export type RebindResult =
  | { readonly ok: true; readonly stored: string; readonly fieldIds: readonly string[] }
  | { readonly ok: false; readonly issue: RebindIssue; readonly candidates: readonly string[] };

export type RebindField = Pick<FormulaField, 'id' | 'name' | 'kind'>;

const unique = (ids: readonly string[]) => [...new Set(ids)];

export function rebindLegacyFormula(source: string, fields: readonly RebindField[]): RebindResult {
  const parsed = parseFormula(source);
  if (!parsed.ok) {
    // 整段解析失败：不能按结构判断，名称粗筛命中的全部字段都算候选（与删除守卫的文本兜底同一口径）
    const candidates = fields.filter((field) => textMentionsField(source, field.name)).map((field) => field.id);
    return { ok: false, issue: 'INVALID', candidates: unique(candidates) };
  }
  const nodes = fieldNodes(parsed.program);
  // 候选：每处 盘点对象.<名>（含更深路径，字段名可以含“.”）在当时全部同名字段
  const named = nodes.filter(startsWithObject).filter((node) => node.path.length > 1);
  const candidates = unique(
    named.flatMap((node) => {
      const name = node.path.slice(1).join('.');
      return fields.filter((field) => field.name === name).map((field) => field.id);
    }),
  );
  const fail = (issue: RebindIssue): RebindResult => ({ ok: false, issue, candidates });

  const references = nodes.filter(isObjectReference);
  const reserved = fields.filter((field) => field.name === RESERVED_NAME);
  if (reserved.length > 1 && references.some((node) => node.path[1] === RESERVED_NAME)) {
    return fail('RESERVED_PATH_CONFLICT');
  }
  const proofs = references.map((node) =>
    node.path[1] === RESERVED_NAME ? (reserved[0]?.id ?? CONTEXT_BINDING) : null,
  );
  const bound = bindFormula(source, {
    visibleFields: fields,
    proofs,
    // 迁移不是用户输入：没有“旧页面”，版本核对不参与
    catalogVersion: { current: 0, submitted: 0 },
  });
  if (!bound.ok) return fail(issueOf(bound.failure));

  const kinds = new Map(fields.map((field) => [field.id, field.kind]));
  if (bound.fieldIds.some((id) => kinds.get(id) === 'multi_option')) return fail('MULTI_OPTION');
  // 防御（B5 已限制 4000 字，理论上不会出现）：规范文本按当前名称渲染后必须能原样重提，否则会破坏 bound 的不变式（契约 §3.1）
  if (!checkRenameRoundTrip(bound.stored, fields).ok) return fail('INPUT_LIMIT');
  return { ok: true, stored: bound.stored, fieldIds: bound.fieldIds };
}

function issueOf(failure: Extract<ReturnType<typeof bindFormula>, { ok: false }>['failure']): RebindIssue {
  switch (failure.code) {
    case 'CALC_FIELD_NAME_AMBIGUOUS':
      return 'AMBIGUOUS_FIELD';
    case 'FORMULA_INVALID': {
      const code = failure.issues[0]?.code;
      return code === 'UNKNOWN_FIELD' ? 'UNKNOWN_FIELD' : code === 'BARE_WORD' ? 'BARE_WORD' : 'INVALID';
    }
    default:
      return 'INVALID';
  }
}
