// AC 编号的提取、展开与排序。格式与追溯表一致：AC-<模块>-<序号>（docs/05_验收/01_验收场景与追溯表.md 编号规则）。
// 模块允许数字开头以兼容 R3 的 AC-360-*；序号 2～3 位且后面不能再接数字。
// 简写沿用 R1 用例标题的写法：AC-ORG-01~09 / 01～09 展开为区间，AC-TRF-01/37/45、AC-TRF-13 / 14 展开为同模块多个编号。
const ID_PATTERN = /AC-([A-Z0-9]+)-(\d{2,3})(?!\d)((?:\s*[/~～]\s*\d{2,3}(?!\d))*)/g;
const STEP_PATTERN = /\s*([/~～])\s*(\d{2,3})/g;
const TOKEN_PATTERN = /^AC-[A-Z0-9]+-\d{2,3}(?:\s*[/~～]\s*\d{2,3})*$/;
const WILDCARD_PATTERN = /^AC-([A-Z0-9]+)-\*$/;

const formatId = (module, n, width) => `AC-${module}-${String(n).padStart(width, '0')}`;

/**
 * 从一段文本（一级标题）中提取编号；调用方逐段调用，不跨段拼接。
 * 区间终点不大于起点（如 AC-DEMO-04~01）属于写错，不展开也不猜测，原文记入 reversed 由调用方报问题。
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
  return { ids: [...ids], reversed: [...new Set(reversed)] };
}

/** 稳定排序：先按模块，再按序号数值。 */
export function compareIds(a, b) {
  const [, moduleA, numberA] = a.match(/^AC-(.+)-(\d+)$/);
  const [, moduleB, numberB] = b.match(/^AC-(.+)-(\d+)$/);
  return moduleA === moduleB ? Number(numberA) - Number(numberB) : moduleA.localeCompare(moduleB);
}

/**
 * 阶段配置的范围写法：单个编号、简写区间，或 AC-<模块>-* 表示该模块全部已定义编号。
 * 认不出、区间逆序、通配匹配不到任何定义时返回 null，由调用方报配置问题。
 */
export function expandScopeToken(token, definedIds) {
  const wildcard = token.match(WILDCARD_PATTERN);
  if (wildcard) {
    // 模块写错时通配会匹配 0 个编号，范围被静默缩小，因此同样按认不出处理
    const ids = definedIds.filter((id) => id.startsWith(`AC-${wildcard[1]}-`)).sort(compareIds);
    return ids.length ? ids : null;
  }
  if (!TOKEN_PATTERN.test(token)) return null;
  const { ids, reversed } = parseIds(token);
  return reversed.length ? null : ids;
}
