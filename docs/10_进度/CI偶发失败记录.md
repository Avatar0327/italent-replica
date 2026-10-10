# CI 偶发失败记录

> 进度窗口维护。记录与所在 PR 改动无关、重跑可过的 CI 失败用例；同一用例出现 2 次以上，建议总编排开 F 任务治理。

| 时间（UTC） | PR / head | 分片 | 用例 | 现象 | 处理 |
|---|---|---|---|---|---|
| 10-10 07:00 | #212 / 6569fa9 | PG 3/3 | limit=1：排在前面的计划未到期，后面已到期的计划一次运行即开启 | 30s 超时 | rerun --failed 转绿 |
| 10-10 08:01 | #212 / 3a569e6 | PG | 同一命令 ID 重放返回原结果；不同命令 ID 重复回补不新增权限行、台账行、业务审计，revision 不变（F-061） | 断言失败（5.4s） | rerun 后转出新失败 → F-086 |
| 10-10 08:23 | #212 / 3a569e6（rerun 第 2 次尝试） | PG 2/3 | AC-PLAT-F061 T-01：开通 → 首次 seeds/backfill：permission 两项 installed 为空；台账与权限表、身份 revision 不变 | 断言失败（6.6s） | 开 F-086 治理 |
| 10-10 ~10:1x | #215 / 第 3 轮（[job](https://github.com/Avatar0327/italent-replica/actions/runs/38048924929/job/114201128515)） | PG 2/3 | AC-PLAT-F061-backfill T-02（权限数组换序） | 断言失败；同一日志中 AC-CT-F016-upgrade-mixed 通过 | 已由 #222 F-086 修复（10-10 更正：原误记为 upgrade-mixed） |
| — | 本地环境 | 本地非超级用户 PG | AC-CT-F016-upgrade-mixed（合同升级迁移） | 只在本地非超级用户 PG 失败，原因 FORCE RLS；CI 未复现 | #231 在该环境下跳过 |
| 10-10 16:51 | #228 / a3a3bf5 | PG 1/3 | （无断言失败）日志末尾 CONNECTION_ENDED | 分片跑满约 18 分钟，疑似撞 timeout-minutes: 18 | 待 rerun；若反复，PG 改 4 片或上限调高 |
