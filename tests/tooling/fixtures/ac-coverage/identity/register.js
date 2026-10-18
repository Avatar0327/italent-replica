// 被导入的注册 helper（不是夹具文件本身）：用例由调用方的文件注册。
import { it } from 'vitest';

export function register(mark, title, label, runs = true) {
  (runs ? it : it.skip)(title, () => mark(label));
}
