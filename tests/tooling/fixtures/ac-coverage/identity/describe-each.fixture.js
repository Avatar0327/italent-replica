// 附录 C 夹具 05：describe.each 的表行标题相同、两档行序相反；叶子在同一调用点注册。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

describe.each(pg ? ['B', 'A'] : ['A', 'B'])('同名套件', (row) => {
  ((pg ? row === 'B' : row === 'A') ? it : it.skip)('AC-ID-05 叶子', () => mark(row));
});
