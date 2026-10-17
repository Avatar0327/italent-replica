// AC 定义：Markdown 表格中首列恰为单个 AC 编号（可带括号说明，支持多段模块，DEC-291②）的行。同一编号以配置顺序中第一次出现为准，
// 其余出现记为重复定义（只提示，不判失败）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MODULE } from './ids.mjs';

const ROW_PATTERN = new RegExp(`^\\|\\s*(AC-${MODULE}-\\d{2,3})(?:\\s*[（(][^|]*)?\\s*\\|`);

function listMarkdown(path) {
  if (statSync(path).isFile()) return path.endsWith('.md') ? [path] : [];
  return readdirSync(path)
    .sort()
    .flatMap((name) => listMarkdown(join(path, name)));
}

export function scanDefinitions(paths, root) {
  const definitions = new Map();
  const duplicates = [];
  for (const file of paths.flatMap(listMarkdown)) {
    const where = relative(root, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const id = line.match(ROW_PATTERN)?.[1];
        if (!id) return;
        const location = `${where}:${index + 1}`;
        if (definitions.has(id)) duplicates.push({ id, location, first: definitions.get(id) });
        else definitions.set(id, location);
      });
  }
  return { definitions, duplicates };
}
