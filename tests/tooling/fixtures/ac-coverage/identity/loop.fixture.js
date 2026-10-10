// 附录 C 夹具 03：同一注册点循环注册同名用例，两档顺序相反；A 只在 PGlite 执行、B 只在 PG 执行。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);
const runs = (row) => (pg ? row === 'B' : row === 'A');

for (const row of pg ? ['B', 'A'] : ['A', 'B']) (runs(row) ? it : it.skip)('AC-ID-03 同名用例', () => mark(row));
