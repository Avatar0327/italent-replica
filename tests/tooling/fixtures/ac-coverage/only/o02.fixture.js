// 附录 B 三层矩阵（v029 型）：run → skip → only 套件 → 叶子 run。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe('外', () => describe.skip('中', () => describe.only('内', () => it('AC-ONLY-02', never('02')))));
it('control', () => mark('control'));
