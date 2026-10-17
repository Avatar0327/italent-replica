// 被导入的 async 注册函数（不是夹具文件本身）：在 setTimeout 之后才调用 describe / it，
// 调用栈上已经没有夹具文件，Vitest 记录不到这次注册的位置（location 为空）。
// 两档可以选用不同的函数注册同名父套件，注册来源不同、位置都“未知”。
import { describe, it } from 'vitest';

const later = (register) => new Promise((resolve) => setTimeout(() => resolve(register()), 0));

export const describeLater = (name, fn) => later(() => describe(name, fn));
export const describeLaterSkipped = (name, fn) => later(() => describe.skip(name, fn));
export const itLater = (title, fn) => later(() => it(title, fn));
