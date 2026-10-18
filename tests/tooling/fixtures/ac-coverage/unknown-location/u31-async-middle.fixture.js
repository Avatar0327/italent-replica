// #102 第 3 轮附录 A 夹具 31：外层位置已知，中间层由各档不同的 async 函数注册（位置未知，PG 档跳过）。
// 祖先位置为 [已知, 未知] 时同样无法确认身份。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';
import { describeLater, describeLaterSkipped } from './later.js';

const mark = marker(import.meta.url);
const pg = Boolean(process.env.AC_FIXTURE_PG);

const middle = async () => {
  await (pg ? describeLaterSkipped : describeLater)('异步注册的中间层', () => {
    it('AC-UL-31 叶子', () => mark(pg ? 'pg' : 'pglite'));
  });
};

describe('位置已知的外层', middle); // @outer
