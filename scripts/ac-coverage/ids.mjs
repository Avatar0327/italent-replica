// AC 编号的提取、展开与排序。格式与追溯表一致：AC-<模块>-<序号>（docs/05_验收/01_验收场景与追溯表.md 编号规则）。
// 模块可以是多段（DEC-291②，如 AC-PRM-FW-01）：首段 [A-Z0-9]+（兼容 R3 的 AC-360-*），其后每段须以字母开头；
// 以数字开头的段即序号，因此既有单段编号的解析结果不变。序号 2～3 位且后面不能再接数字。
// 简写沿用 R1 用例标题的写法：AC-ORG-01~09 / 01～09 展开为区间，AC-TRF-01/37/45、AC-TRF-13 / 14 展开为同模块多个编号。
export const MODULE = '[A-Z0-9]+(?:-[A-Z][A-Z0-9]*)*';
const ID_SOURCE = `AC-(${MODULE})-(\\d{2,3})(?!\\d)((?:\\s*[/~～]\\s*\\d{2,3}(?!\\d))*)`;
const ID_PATTERN = new RegExp(ID_SOURCE, 'g');
const STEP_PATTERN = /\s*([/~～])\s*(\d{2,3})/g;
const TOKEN_PATTERN = new RegExp(`^AC-${MODULE}-\\d{2,3}(?:\\s*[/~～]\\s*\\d{2,3})*$`);
const WILDCARD_PATTERN = new RegExp(`^AC-(${MODULE})-\\*$`);
// 标题里以 AC- 开头的“词”（字母、数字、下划线、连字符），用于找出解析不完整的写法
const CANDIDATE_PATTERN = /AC-[A-Za-z0-9_]*(?:-[A-Za-z0-9_]*)*/g;
// 区间终点写成完整编号（如 AC-PRM-03～AC-PRM-05）：语法只认终点序号，不能静默拆成两个单号
const FULL_RANGE_END = new RegExp(`AC-${MODULE}-\\d{2,3}\\s*[~～]\\s*AC-[A-Za-z0-9_-]*`, 'y');

const formatId = (module, n, width) => `AC-${module}-${String(n).padStart(width, '0')}`;
const moduleOf = (id) => id.slice('AC-'.length, id.lastIndexOf('-'));

/**
 * 一个 AC- 开头的词是否在写编号：AC- 之后只有模块名（如 AC-TRF、AC-PRM-FW）是模块统称，不算编号；
 * 第二段起出现空段或以数字开头的段，就是在写编号。
 */
function isIdAttempt(token) {
  const segments = token.slice('AC-'.length).split('-');
  return segments.length > 1 && segments.slice(1).some((segment) => segment === '' || /^\d/.test(segment));
}

/** 写编号却不能被完整解析的写法（一位序号、空段、连写、小写、区间终点写全称等），原样返回。 */
function malformedIn(text) {
  const malformed = [];
  for (const candidate of text.matchAll(CANDIDATE_PATTERN)) {
    const token = candidate[0].replace(/-+$/, '');
    if (!isIdAttempt(token)) continue;
    const parsed = new RegExp(ID_SOURCE, 'y');
    parsed.lastIndex = candidate.index;
    const match = parsed.exec(text);
    FULL_RANGE_END.lastIndex = candidate.index;
    const fullRangeEnd = FULL_RANGE_END.exec(text);
    if (fullRangeEnd) malformed.push(fullRangeEnd[0].trim());
    else if (!match || `AC-${match[1]}-${match[2]}` !== token) malformed.push(token);
  }
  return malformed;
}

/**
 * 从一段文本（一级标题）中提取编号；调用方逐段调用，不跨段拼接。
 * 区间终点不大于起点（如 AC-DEMO-04~01）属于写错，不展开也不猜测，原文记入 reversed；
 * 写编号却解析不完整的写法记入 malformed。两者都由调用方报问题。
 */
export function parseIds(text) {
  const ids = new Set();
  const reversed = [];
  for (const [whole, module, first, rest] of text.matchAll(ID_PATTERN)) {
    const width = first.length;
    let previous = Number(first);
    ids.add(formatId(module, previous, width));
    for (const [, separator, digits] of rest.matchAll(STEP_PATTERN)) {
      const value = Number(digits);
      if (separator === '/') ids.add(formatId(module, value, width));
      else if (value <= previous) reversed.push(whole.trim());
      else for (let n = previous + 1; n <= value; n++) ids.add(formatId(module, n, width));
      previous = value;
    }
  }
  return { ids: [...ids], reversed: [...new Set(reversed)], malformed: [...new Set(malformedIn(text))] };
}

/** 稳定排序：先按完整模块名，再按序号数值。 */
export function compareIds(a, b) {
  const [, moduleA, numberA] = a.match(/^AC-(.+)-(\d+)$/);
  const [, moduleB, numberB] = b.match(/^AC-(.+)-(\d+)$/);
  return moduleA === moduleB ? Number(numberA) - Number(numberB) : moduleA.localeCompare(moduleB);
}

/**
 * 阶段配置的范围写法：单个编号、简写区间，或 AC-<模块>-* 表示该模块全部已定义编号（按完整模块名精确匹配，
 * AC-PRM-* 不含 AC-PRM-FW-*）。认不出、区间逆序、通配匹配不到任何定义时返回 null，由调用方报配置问题。
 */
export function expandScopeToken(token, definedIds) {
  const wildcard = token.match(WILDCARD_PATTERN);
  if (wildcard) {
    // 模块写错时通配会匹配 0 个编号，范围被静默缩小，因此同样按认不出处理
    const ids = definedIds.filter((id) => moduleOf(id) === wildcard[1]).sort(compareIds);
    return ids.length ? ids : null;
  }
  if (!TOKEN_PATTERN.test(token)) return null;
  const { ids, reversed } = parseIds(token);
  return reversed.length ? null : ids;
}
