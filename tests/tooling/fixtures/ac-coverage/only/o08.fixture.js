// 附录 B runIf 链式组合（v297 / v298 型）：skip 套件下的 it.runIf(true).only。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe.skip('外', () => it.runIf(true).only('AC-ONLY-08', never('08')));
it('control', () => mark('control'));
