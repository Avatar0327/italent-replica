// 正常文件：范围内唯一的编号在这里运行，因此 --check 失败只能来自另外两个文件的收集错误。
import { it } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);

it('AC-ERR-01 正常覆盖', () => mark('01'));
