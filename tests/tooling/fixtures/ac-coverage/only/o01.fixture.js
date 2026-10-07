// 附录 B 最小例：describe → describe → describe.skip → test.only；同文件 control 被 only 压成 skip。
import { describe, it, test } from 'vitest';
import { marker } from '../marker.js';

const mark = marker(import.meta.url);
const never = (label) => () => {
  mark(label);
  throw new Error('夹具：被跳过的 only 用例不应执行');
};

describe('外', () => describe('中', () => describe.skip('内', () => test.only('AC-ONLY-01', never('01')))));
it('control', () => mark('control'));
