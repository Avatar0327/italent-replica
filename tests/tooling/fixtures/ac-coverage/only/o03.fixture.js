// 附录 B 三层矩阵（v068 型）：skip → run → run → 叶子 only。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe.skip('外', () => describe('中', () => describe('内', () => it.only('AC-ONLY-03', never('03')))));
it('control', () => mark('control'));
