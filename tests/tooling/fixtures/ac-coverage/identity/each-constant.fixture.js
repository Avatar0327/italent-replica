// 附录 C 夹具 13：test.each 标题不含参数，两档注册的参数行不同（A/B 与 C/D）。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

it.each(pg ? ['C', 'D'] : ['A', 'B'])('AC-ID-13 常量标题', (row) => mark(row));
