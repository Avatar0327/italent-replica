# R3-T04 PR-B7a 项目配置与状态机路由声明

依据：拆分方案 §2 / §3（DEC-353）、总设计 §2.4 / §3.1 / §6.1 / §7。作用对象：复刻系统。
前缀 `/api/tenant/talent-review/projects`，权限对象 `TalentReview.Project`，应用 `TalentReview`。

| 路由 | 数据操作权 | 按钮 | 范围 / 字段 |
|---|---|---|---|
| GET / | view | 无 | 所属组织 ∪ 所属人，SQL 分页前过滤；按项目字段查看权裁剪 |
| GET /:id | view | 无 | 同一管理范围，范围外 / 不存在同为 404；嵌套字段随各自配置字段裁剪 |
| POST / | create | create@list | 目标组织须在范围内；人工配置逐字段检查编辑权 |
| PATCH /:id | update | update@detail | 当前管理范围；改组织另查目标范围；含清空逐字段检查 |
| DELETE /:id | delete | delete@detail | 当前管理范围，须无对象；删除快照按当前字段权返回 |
| POST /:id/start | update | start@detail | 当前管理范围；仅 new 可启动 |
| POST /:id/end | update | end@detail | 当前管理范围；new / in_progress 可结束 |
| POST /:id/restart | update | restart@detail | 当前管理范围；仅 ended 可重启，ended_count +1 |

管理范围复用统一 `scopeSql` / `visible`，缺省为空；所有写入口以 `commands.ts` 的 `ledgerExit → CommandGuard.before`
复核当前操作权、按钮、范围和输入字段权；重放按当前项目归属判定，删除重放按快照归属判定。
显式引用分类 / 计算规则 / 九宫格 / 校准字段时，另需对应目录对象查看权与目录范围；新引用不能停用。
共享组织只验本租户存在性；规则组须属于选中九宫格；校准原因须来自 calibration 分组。
TR-R7 缺省九宫格由系统带入全部启用项，比例规则组取各九宫格默认组（无默认组则空）。

| 状态 | 编辑 | start | end | restart | 删除（无对象） |
|---|---|---|---|---|---|
| new | 允许 | in_progress | ended | 409 | 允许 |
| in_progress | 允许 | 409 | ended | 409 | 允许 |
| ended | 409 PROJECT_ENDED | 409 | 409 | in_progress | 允许 |

PR-C / PR-D 通过 `registerProjectGuard` 接入 start / end / restart 事务内守卫，通过 `registerProjectObjectCheck` 接入真实对象存在查询。
守卫在项目 X 锁、revision 和状态检查后执行；拒绝整体回滚。PR-C 新增 / 删除对象必须先取项目 S 锁。
本 PR 不执行采集、比例校验、calc run 阻塞或同步 run superseded；公开 / 共享只读谓词、人才标准引用归 B7b。
`calc_state` / `last_full_calc_at` 只建只读；无实际开始 / 结束时间和 result_version 列。
