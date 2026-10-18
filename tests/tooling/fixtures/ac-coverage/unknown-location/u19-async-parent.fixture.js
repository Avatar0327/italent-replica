// #102 第 3 轮附录 A 夹具 19：父套件由被导入的 async 函数注册，位置未知；叶子位置已知。
// 两档写法相同，但“未知”不能证明是同一个注册：报 identity，不合并，不计入覆盖（DEC-282 补充）。
import { it } from 'vitest';
import { marker } from '../marker.js';
import { describeLater } from './later.js';

const mark = marker(import.meta.url);

await describeLater('异步注册的父套件', () => {
  it('AC-UL-19 叶子', () => mark('19'));
});
