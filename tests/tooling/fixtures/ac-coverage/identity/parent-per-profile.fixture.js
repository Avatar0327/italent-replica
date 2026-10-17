// 附录 C 夹具 18：每档只注册一个叶子，但父套件来自不同的注册位置。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);
const leaf = (label) => () => it('AC-ID-18 叶子', () => mark(label));

if (pg)
  describe('同名父套件', leaf('pg-parent')); // @pg-parent
else describe('同名父套件', leaf('pglite-parent')); // @pglite-parent
