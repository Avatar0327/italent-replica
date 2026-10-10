// 附录 C 夹具 17：两个同名父套件注册在不同位置，叶子来自同一 helper；两档注册顺序相反。
// A 只在 PGlite 执行、B 只在 PG 执行。DEC-282：同一档内“文件 + 名称路径 + 位置”相同即身份冲突。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);
const leaf = (row, runs) => (runs ? it : it.skip)('AC-ID-17 叶子', () => mark(row));
const suiteA = () => describe('同名父套件', () => leaf('A', !pg)); // @parent-A
const suiteB = () => describe('同名父套件', () => leaf('B', pg)); // @parent-B

if (pg) {
  suiteB();
  suiteA();
} else {
  suiteA();
  suiteB();
}
