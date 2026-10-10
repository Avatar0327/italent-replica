// 对照：顶层用例（祖先为空）与位置已知的父套件下的用例，身份可确认，照常跨档合并。
import { describe, it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);

it('AC-UL-01 顶层对照', () => mark('01'));
describe('位置已知的父套件', () => {
  it('AC-UL-02 嵌套对照', () => mark('02'));
});
