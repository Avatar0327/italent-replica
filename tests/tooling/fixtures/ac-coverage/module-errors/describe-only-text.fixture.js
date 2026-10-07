// describe 回调抛出与 Vitest 拒绝 .only 时逐字相同的消息：Vitest 记为模块收集错误。
// 工具不按消息文本分辨错误来源（DEC-282 补充），模块错误一律原样报出。
import { describe, it } from 'vitest';

describe('抛错的套件', () => {
  it('AC-ERR-02 抛错前注册', () => {});
  throw new Error('[Vitest] Unexpected .only modifier. Remove it or pass --allowOnly argument to bypass this error');
});
