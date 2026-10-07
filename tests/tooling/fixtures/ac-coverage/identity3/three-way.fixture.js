// 附录 C 夹具 12：三档在同一注册点注册同名用例、顺序各不相同；每档只执行排在第一的那一行。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const order = { a: ['A', 'B', 'C'], b: ['B', 'C', 'A'], c: ['C', 'A', 'B'] }[process.env.AC_FIXTURE_PROFILE ?? 'a'];

for (const row of order) (row === order[0] ? it : it.skip)('AC-ID-12 同名用例', () => mark(row));
