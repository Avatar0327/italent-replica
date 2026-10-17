// #102 第 3 轮附录 A 夹具 29：用例本身由被导入的 async 函数注册，用例位置未知。
import { marker } from '../marker.js';
import { itLater } from './later.js';

const mark = marker(import.meta.url);

await itLater('AC-UL-29 异步注册的叶子', () => mark('29'));
