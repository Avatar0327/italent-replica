/** 括号及括号内的标注（演示、测试等）不是姓名的一部分：全角 / 半角圆括号、方括号、书名号。 */
const ANNOTATION = /[（(【[][^）)】\]]*[）)】\]]/g;

/**
 * 头像缩写（F-141 ⑦，DEC-500）：先去掉括号标注再取字。英文名取首尾词的首字母，中文取末尾两字。
 * 只有标注没有姓名时，退回标注里的字，避免头像空白。
 */
export function avatarInitials(name: string): string {
  const full = name.trim();
  const cleaned = full.replace(ANNOTATION, '').trim();
  const base = cleaned || full.replace(/[（()）【】[\]]/g, '').trim();
  const parts = base.split(/\s+/);
  if (/^[a-z]/i.test(parts[0] ?? ''))
    return `${parts[0]?.[0] ?? ''}${parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''}`.toUpperCase();
  return Array.from(base).slice(-2).join('');
}
