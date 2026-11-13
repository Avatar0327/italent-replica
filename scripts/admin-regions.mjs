/** F-474-8b §3.1 / §6，DEC-897：离线解析存档副本，按父级优先切片，原文件不入库。
 * node scripts/admin-regions.mjs generate|check <来源文件> <片号> <迁移.sql>
 * generate 追加或替换本工具的播种块；check 只校验，保留迁移中的建表、注释与授权 SQL。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const source = JSON.parse(readFileSync(new URL('./admin-regions-source.json', import.meta.url), 'utf8'));
const municipalities = new Set(['110000', '120000', '310000', '500000']);
const start = '-- F474-8c admin_regions seed begin';
const end = '-- F474-8c admin_regions seed end';
const blockPattern = /-- F474-8c admin_regions seed begin\n[\s\S]*?-- F474-8c admin_regions seed end\n/g;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const quote = (value) => (value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`);

function cellText(cell) {
  return cell
    .replace(/<[^>]*>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .trim();
}

export function parseRegions(html) {
  const records = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cellText(cell[1]));
    const index = cells.findIndex((cell) => /^\d{6}$/.test(cell));
    if (index < 0) continue;
    const code = cells[index];
    const name = cells[index + 1];
    if (!name) throw new Error(`区划缺少名称 ${code}`);
    let level = 3;
    if (code.endsWith('00')) level = 2;
    if (code.endsWith('0000')) level = 1;
    // 原页脚注 2 明确 * 为省直辖县级单位；四个直辖市按原页直接下辖区县。
    const province = `${code.slice(0, 2)}0000`;
    const direct = municipalities.has(province) || (code.slice(2, 4) === '90' && name.endsWith('*'));
    let parentCode = null;
    if (level > 1) parentCode = province;
    if (level === 3 && !direct) parentCode = `${code.slice(0, 4)}00`;
    records.push({ code, parentCode, level, name: name.replace(/\*$/, '') });
  }
  if (records.length > 4000) throw new Error('【等决定】区划总数超过 4000');
  const byCode = new Map(records.map((record) => [record.code, record]));
  if (byCode.size !== records.length) throw new Error('区划代码重复');
  for (const record of records) {
    if (record.parentCode === null) continue;
    const parent = byCode.get(record.parentCode);
    if (!parent || parent.level >= record.level) throw new Error(`【等决定】父级缺损 ${record.code}`);
  }
  if (![1, 2, 3].every((level) => records.some((record) => record.level === level))) {
    throw new Error('【等决定】来源缺少省、市或县层级');
  }
  return records.sort((a, b) => a.level - b.level || a.code.localeCompare(b.code));
}

export function verifySource(bytes) {
  if (digest(bytes) !== source.sha256) throw new Error('来源 SHA-256 与固定存档不符');
  const records = parseRegions(bytes.toString('utf8'));
  const levels = [1, 2, 3].map((level) => records.filter((record) => record.level === level).length);
  if (records.length !== source.total || JSON.stringify(levels) !== JSON.stringify(source.levels)) {
    throw new Error('来源总数或分级数与固定摘要不符');
  }
  return records;
}

export function seedBlock(records, part, size = source.sliceSize) {
  if (!Number.isInteger(size) || size < 1 || size > 2000) throw new Error('分片上限为 2000 条');
  if (!Number.isInteger(part) || part < 1 || part > Math.ceil(records.length / size)) {
    throw new Error('片号超出来源范围');
  }
  const slice = records.slice((part - 1) * size, part * size);
  const lines = slice.map((r) => `(${quote(r.code)}, ${quote(r.parentCode)}, ${r.level}, ${quote(r.name)})`);
  return `${start}\nINSERT INTO admin_regions (code, parent_code, level, name) VALUES\n${lines.join(',\n')};\n${end}\n`;
}

function main() {
  const [mode, input, partText, output] = process.argv.slice(2);
  if (!['generate', 'check'].includes(mode) || !input || !partText || !output || process.argv.length !== 6) {
    throw new Error('用法：node scripts/admin-regions.mjs generate|check <来源文件> <片号> <迁移.sql>');
  }
  const records = verifySource(readFileSync(input));
  const part = Number(partText);
  const block = seedBlock(records, part);
  const expected = source.slices[part - 1];
  if (!expected || digest(block) !== expected.sha256) throw new Error('播种块与固定分片摘要不符');
  const original = existsSync(output) ? readFileSync(output, 'utf8') : '';
  const blocks = original.match(blockPattern) ?? [];
  if (blocks.length > 1) throw new Error('迁移中存在重复播种块');
  if (mode === 'check') {
    if (blocks[0] !== block) throw new Error('迁移播种块与来源生成结果不符');
  } else {
    const updated = blocks.length ? original.replace(blockPattern, () => block) : `${original}${block}`;
    writeFileSync(output, updated);
  }
  console.log(JSON.stringify({ version: source.version, total: records.length, part, ...expected }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
