// 夹具执行标记：真实运行时把“哪个用例体被执行了”写进 AC_MARKER_FILE，
// 测试用它核对工具关于“哪一档运行了哪个注册”的结论（#102 第 2 轮审查要求用执行 marker 断言）。
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function marker(moduleUrl) {
  const file = basename(fileURLToPath(moduleUrl));
  return (label) => {
    if (process.env.AC_MARKER_FILE) appendFileSync(process.env.AC_MARKER_FILE, `${file}:${label}\n`);
  };
}
