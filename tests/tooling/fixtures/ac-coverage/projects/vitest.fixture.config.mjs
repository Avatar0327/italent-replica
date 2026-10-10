// 夹具专用 Vitest 配置（#102 第 3 轮附录 A 夹具 33）：两个具名 project 都收集 same-file.fixture.js，
// 另有只属于 project A 的文件作对照。project 名经 env 传给用例体，供执行 marker 区分。
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const project = (name, include) => ({
  test: { name, root, include, environment: 'node', env: { AC_FIXTURE_PROJECT: name } },
});

export default defineConfig({
  root,
  test: {
    projects: [project('A', ['same-file.fixture.js', 'only-a.fixture.js']), project('B', ['same-file.fixture.js'])],
  },
});
