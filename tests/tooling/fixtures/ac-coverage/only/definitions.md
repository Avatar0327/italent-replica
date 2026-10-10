# 夹具 AC 定义（only 门禁）

| 编号 | 场景 |
|---|---|
| AC-ONLY-01 | describe → describe → describe.skip → test.only |
| AC-ONLY-02 | 三层：run → skip → only 套件 → 叶子 run |
| AC-ONLY-03 | 三层：skip → run → run → 叶子 only |
| AC-ONLY-04 | 三层：todo → only → run → 叶子 run |
| AC-ONLY-05 | 四层：skip → only → run → only → 叶子 run |
| AC-ONLY-06 | 四层：todo → only → skip → run → 叶子 only |
| AC-ONLY-07 | options：skip 选项套件下的 { only: true } 用例 |
| AC-ONLY-08 | runIf 链：skip 套件下的 it.runIf(true).only |
| AC-ONLY-09 | 条件链：PGlite 档被 skip 挡住、PG 档生效的 describe.only |
| AC-ONLY-10 | 未被跳过的 it.only（Vitest 报收集失败） |
