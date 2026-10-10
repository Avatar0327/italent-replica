// 附录 B 三层矩阵（v177 型）：todo → only → run → 叶子 run。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe.todo('外', () => describe.only('中', () => describe('内', () => it('AC-ONLY-04', never('04')))));
it('control', () => mark('control'));
