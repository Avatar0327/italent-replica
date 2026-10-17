// 夹具 05 的变体：run / skip 分别在两个调用点注册，叶子位置随行变化，
// 只看“文件 + 名称路径 + 叶子位置”每档都唯一；但两个同名、同位置的父套件本身无法区分，仍属身份冲突。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

describe.each(pg ? ['B', 'A'] : ['A', 'B'])('同名套件', (row) => {
  if (pg ? row === 'B' : row === 'A') it('AC-ID-06 叶子', () => mark(row));
  else it.skip('AC-ID-06 叶子', () => mark(row));
});
