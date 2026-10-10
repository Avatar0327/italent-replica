/**
 * 计算规则审计的读取裁剪（F-082 契约 §5.3，DEC-376④、DEC-197）：审计行按写入时的完整内容保存，查询出口再按查看人
 * **当前**的字段目录可见集合裁剪——规范文本里的句柄换成历史名称或占位符，`refFieldIds` / `fieldNames` 去掉不可见字段的 ID。
 * 纯函数；前后值、快照、差异（from / to）共用，由 API 层的 calcRuleSources 在 visibleValue / visibleChanges 之前调用。
 */
import { HIDDEN_FIELD_PLACEHOLDER } from '../expression/index.js';
import { renderFormula, FORMULA_REPAIR_NOTICE } from './formula-binding.js';

export interface AuditFieldDirectory {
  /** 查看人当前可见的字段：字段 ID（小写）→ 当前名称（字段目录范围内且 name / kind / enabled / systemWritten 四列可见）。 */
  readonly visible: ReadonlyMap<string, string>;
  /** 查看人能看到租户的全部字段（无法解析的历史公式只对这样的人显示原文）。 */
  readonly allVisible: boolean;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/** 计算项目的审计表示：有 formula 与 targetFieldId。 */
const isItem = (value: Json) => typeof value['formula'] === 'string' && typeof value['targetFieldId'] === 'string';

/** 深度遍历，只在内容真的被改动时才产生新对象（未改动的返回原对象）。 */
export function redactCalcRuleAuditValue(value: unknown, directory: AuditFieldDirectory): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => redactCalcRuleAuditValue(entry, directory));
    return mapped.some((entry, index) => entry !== value[index]) ? mapped : value;
  }
  if (!isObject(value)) return value;
  const inner: Json = {};
  let changed = false;
  for (const [key, entry] of Object.entries(value)) {
    const next = redactCalcRuleAuditValue(entry, directory);
    inner[key] = next;
    if (next !== entry) changed = true;
  }
  const refs = filterRefs(changed ? inner : value, directory);
  const hinted = filterHints(refs.value, directory);
  const item = isItem(hinted.value) ? redactItem(hinted.value, directory) : hinted.value;
  const touched = changed || refs.changed || hinted.changed || item !== hinted.value;
  if (!touched) return value;
  // 差异里前后值被裁剪过：写入时保存的派生文本（fromText / toText）可能带着旧内容，丢掉让出口按裁剪后的值重新生成
  return isChange(item) ? withoutDerivedText(item) : item;
}

const isChange = (value: Json) => typeof value['field'] === 'string' && 'from' in value && 'to' in value;
const withoutDerivedText = ({ fromText: _from, toText: _to, ...rest }: Json): Json => rest;

/** refFieldIds / fieldNames：只留查看人可见的字段。 */
function filterRefs(value: Json, directory: AuditFieldDirectory): { value: Json; changed: boolean } {
  const ids = value['refFieldIds'];
  const names = value['fieldNames'];
  if (!Array.isArray(ids) && !isObject(names)) return { value, changed: false };
  const out: Json = { ...value };
  let changed = false;
  if (Array.isArray(ids)) {
    const kept = ids.filter((id) => typeof id === 'string' && directory.visible.has(id.toLowerCase()));
    if (kept.length !== ids.length) changed = true;
    out['refFieldIds'] = kept;
  }
  if (isObject(names)) {
    const kept = Object.fromEntries(Object.entries(names).filter(([id]) => directory.visible.has(id.toLowerCase())));
    if (Object.keys(kept).length !== Object.keys(names).length) changed = true;
    out['fieldNames'] = kept;
  }
  return { value: changed ? out : value, changed };
}

const ids = (list: unknown, directory: AuditFieldDirectory): string[] =>
  Array.isArray(list)
    ? list.filter((id): id is string => typeof id === 'string' && directory.visible.has(id.toLowerCase()))
    : [];

/**
 * hints（契约 §5.3 第 3 步，只作防御：B5 起审计就不含 hints）。审计里没有结构化诊断，无法判断 warnings 文案提到的字段是否可见，
 * 所以 order / blocked / cycles 只留可见的目标字段 ID（环要全部成员可见），warnings 一律汇总为不含名称的计数提示。
 */
function filterHints(value: Json, directory: AuditFieldDirectory): { value: Json; changed: boolean } {
  const hints = value['hints'];
  if (!isObject(hints)) return { value, changed: false };
  const cycles = Array.isArray(hints['cycles'])
    ? (hints['cycles'] as unknown[]).filter(
        (cycle) => Array.isArray(cycle) && ids(cycle, directory).length === cycle.length,
      )
    : [];
  const warnings = Array.isArray(hints['warnings']) ? hints['warnings'].length : 0;
  const out: Json = {
    ...hints,
    order: ids(hints['order'], directory),
    blocked: ids(hints['blocked'], directory),
    cycles,
    warnings: warnings > 0 ? [`另有 ${warnings} 条提示涉及不可见的字段，未显示`] : [],
  };
  return { value: { ...value, hints: out }, changed: true };
}

/** 一个计算项目的公式：新格式（formulaBinding = bound）用写入时刻的名称渲染，旧格式按 legacy 规则。 */
function redactItem(item: Json, directory: AuditFieldDirectory): Json {
  const formula = item['formula'] as string;
  const text =
    item['formulaBinding'] === 'bound' ? renderStored(item, formula, directory) : renderOld(formula, directory);
  return text === formula ? item : { ...item, formula: text };
}

function renderStored(item: Json, formula: string, directory: AuditFieldDirectory): string {
  const historical = isObject(item['fieldNames']) ? (item['fieldNames'] as Record<string, unknown>) : {};
  const visibleFields = [...directory.visible].map(([id, current]) => ({
    id,
    // 历史名称优先（审计记录的是写入那一刻的样子）；没有记录就用当前名称
    name: typeof historical[id] === 'string' ? (historical[id] as string) : current,
  }));
  const rendered = renderFormula(formula, { binding: 'bound', visibleFields });
  return rendered.ok ? rendered.text : FORMULA_REPAIR_NOTICE;
}

function renderOld(formula: string, directory: AuditFieldDirectory): string {
  const visibleFields = [...directory.visible].map(([id, name]) => ({ id, name }));
  const rendered = renderFormula(formula, { binding: 'legacy', visibleFields, allFieldsVisible: directory.allVisible });
  return rendered.ok ? rendered.text : FORMULA_REPAIR_NOTICE;
}

export { HIDDEN_FIELD_PLACEHOLDER };
