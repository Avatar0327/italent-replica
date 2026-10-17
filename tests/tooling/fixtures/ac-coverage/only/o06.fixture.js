// 附录 B 四层组合（v284 型）：todo → only → skip → run → 叶子 only。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe.todo('一', () =>
  describe.only('二', () => describe.skip('三', () => describe('四', () => it.only('AC-ONLY-06', never('06'))))),
);
it('control', () => mark('control'));
