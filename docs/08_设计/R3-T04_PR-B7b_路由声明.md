# R3-T04 PR-B7b 项目可见性与人才标准引用路由声明

依据：拆分方案 B7b、总设计 §2.4 / §5.1 / §6.1 / §6.2 / §6.5 / §7。作用对象：复刻系统。
沿用 B7a 的 8 条项目路由，不增加 calculate / sync 的业务执行接口。

| 路由 | 对象 / 操作 | 按钮 | 范围与判定 |
| --- | --- | --- | --- |
| GET /projects | TalentReview.Project:view | 无 | 管理 ∪ 行政向下公开 ∪ 共享组织，SQL 分页前过滤 |
| GET /projects/:id | TalentReview.Project:view | 无 | 同一可见性；范围外与不存在同为 404 |
| POST /projects | TalentReview.Project:create | create@list | 目标所属组织须在管理范围内 |
| PATCH /projects/:id | TalentReview.Project:update | update@detail | 可管理；只读 403 PROJECT_READONLY；改所属组织另查目标范围 |
| DELETE /projects/:id | TalentReview.Project:delete | delete@detail | 可管理；只读 403 PROJECT_READONLY |
| POST /projects/:id/start | TalentReview.Project:update | start@detail | 可管理；只读 403 PROJECT_READONLY |
| POST /projects/:id/end | TalentReview.Project:update | end@detail | 同上 |
| POST /projects/:id/restart | TalentReview.Project:update | restart@detail | 同上 |

scope 由统一解析器按对象应用 TalentReview 取得，TenantBase 范围不参与。
向下公开复用 permission/public-down 的行政维度祖先查询，以租户时区请求当天的组织版本判定。
共享组织匹配范围展开后的管理 / 组织维度组织集合。创建人范围不会推导共享组织。
列表 / 详情在字段裁剪后追加协议元数据 accessLevel（manage / readonly），不依赖组织字段是否可见。
写响应也返回 manage。所有配置字段（含 criterionId 清空）继续走 B7a 字段编辑权与字段裁剪。

项目行锁后统一调用 requireProjectEditable，再校验 revision、状态与业务守卫；命令重放复用同一判定。
嵌套项目写路径通过 F-039 登记的中间件复用此入口，覆盖 start / end / restart 与后续 calculate / sync 的只读拒绝边界。
calculate / sync 业务执行仍归 PR-C / D，其命令事务也须复用 requireProjectEditable；本 PR 管理者访问未实现接口仍为 404。

人才标准首次保存及项目配置保存：来源标准 FOR SHARE → isTalentCriterionReferenceable（租户内、存在、启用）→ 写项目。
缺失 / 跨租户 / 停用统一 400 CRITERION_NOT_REFERENCEABLE。criterionId UUID 规范化，未提交保留、null 清空。
项目引用登记到 registerConfigReferenceGuard('criterion')，人才标准端口登记仅桥接 configReferrer；
人才标准删除持来源 FOR UPDATE 后询问同一注册表，引用存在返回 409 CRITERION_REFERENCED。
人才标准修改持同一来源 FOR UPDATE 后调用 checkConfigUpdateConstraints；停用会使项目配置失效，
通过 registerConfigUpdateConstraint('criterion') 返回 409 CRITERION_DISABLE_BREAKS_PROJECT；改名等有效属性修改允许。
项目检查 / 引用写入与来源属性检查 / 修改各自在同一事务内完成；标准守卫查询项目不再加项目锁，避免反向锁序。
原 B7a 的校准字段约束继续在同一注册表，既有模板标准拒删守卫保留。

F-039 同步 policy、必需项表、primitive、冻结基准、发现探测与证据摘要；未改核心门禁文件。
新增迁移由 db:generate 生成：项目 criterion_id 与租户复合外键；最终迁移号由合并窗口重排（DEC-430①）。
