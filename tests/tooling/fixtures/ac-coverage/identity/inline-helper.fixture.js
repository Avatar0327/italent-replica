// 附录 C 夹具 04：同文件内的 helper 重复调用、两档调用顺序相反。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);
const register = (row, runs) => (runs ? it : it.skip)('AC-ID-04 同名用例', () => mark(row));

if (pg) {
  register('B', true);
  register('A', false);
} else {
  register('A', true);
  register('B', false);
}
