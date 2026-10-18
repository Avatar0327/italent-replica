// 对照：未被跳过的 it.only，Vitest 在 allowOnly: false 下记为收集失败。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

it.only('AC-ONLY-10', never('10'));
it('control', () => mark('control'));
