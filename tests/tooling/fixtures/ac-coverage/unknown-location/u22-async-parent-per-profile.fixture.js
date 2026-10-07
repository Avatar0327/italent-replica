// #102 第 3 轮附录 A 夹具 22：两档用不同的被导入 async 函数注册同名父套件（PGlite 运行、PG 跳过），
// 父套件位置都未知、叶子位置相同。旧实现把 [null] 当成相同祖先，合并成 {pglite: run, pg: skip}。
import { it } from 'vitest';
import { marker } from '../marker.js';
import { describeLater, describeLaterSkipped } from './later.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

await (pg ? describeLaterSkipped : describeLater)('异步注册的父套件', () => {
  it('AC-UL-22 叶子', () => mark(pg ? 'pg' : 'pglite'));
});
