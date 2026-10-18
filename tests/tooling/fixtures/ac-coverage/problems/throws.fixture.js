// describe 回调抛错：收集失败，应列为问题而不是静默少算。
import { describe, it } from 'vitest';

describe('收集时抛错', () => {
  it('抛错前注册的用例', () => {});
  throw new Error('夹具：收集失败');
});
