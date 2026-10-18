// 附录 B options 组合（v291 型）：skip 选项的套件下，用例以 { only: true } 注册。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe('外', { skip: true }, () => it('AC-ONLY-07', { only: true }, never('07')));
it('control', () => mark('control'));
