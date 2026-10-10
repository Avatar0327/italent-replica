// 附录 B 四层组合（v277 型）：skip → only → run → only → 叶子 run。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe.skip('一', () =>
  describe.only('二', () => describe('三', () => describe.only('四', () => it('AC-ONLY-05', never('05'))))));
it('control', () => mark('control'));
