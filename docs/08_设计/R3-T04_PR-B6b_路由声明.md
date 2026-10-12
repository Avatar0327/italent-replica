# R3-T04 PR-B6b 模板复制、删除与引用保护

依据：人才盘点设计 §2.3 / §7、TR-R12 / TR-R20、DEC-425 模块身份映射、DEC-436 范围调整。
本片新增一条路由；启停与删除沿用 B6a 的 PATCH / DELETE。

| 路由 | 对象 / 按钮 | 范围与字段 | 命令与响应 |
| --- | --- | --- | --- |
| `POST /api/tenant/talent-review/templates/:id/copy` | Template.create + view；copy@list | 原件须可管理，原件所属组织须可新建；仅输入 name，检查 name 编辑权；自动带入的评价规则 / 模块等级 / 字段另需目录查看权及范围 | If-Match 是原件 revision；201 新模板；同键同内容重放、异内容 409；返回体沿用模板投影 |
| `PATCH /api/tenant/talent-review/templates/:id` | Template.update；update@detail | 既有组织范围与字段编辑权 | enabled 启停只改头部，不生成结构版本；无流程不能启用 |
| `DELETE /api/tenant/talent-review/templates/:id` | Template.delete；delete@detail | 既有组织范围 | 未引用可删除；引用挂点拒绝时 409 TEMPLATE_IN_USE；同事务删除快照审计 |

## 复制语义

- name 为必填新名称；原件所属组织与向下公开设置带入，创建人 / 更新时间归当前命令。
- 只复制当前版本的模块、等级 / 评价规则冻结快照、模块字段、结果设置；不重新读取实时规则快照。
- flowId 清空，enabled=false，revision / currentVersionNo / versionNo 从 1 开始，不复制旧版本列表。
- 步骤、权限与表单选用清空。重选流程后由既有默认物化逻辑生成权限：指标可见、评分 / 评语启用、不必填、权重空；继任两项 hidden；showMatrix=false。
- 复用 buildPlan 的来源配置 → 字段 → 目录版本锁序，以及旧模块 ID → 新模块 ID 的公式绑定迁移；落库前清空跨模板的 previousModuleId。之后各自版本链与改名互不影响。
- 复制是新引用，来源规则 / 等级 / 字段 / 人才标准须仍启用；停用原件本身不妨碍复制。复制与原件编辑共用原件行锁：编辑先提交则旧 revision 409，复制先提交则得到完整旧版本且原件编辑可继续。

## 引用守卫与范围边界

- 表单补 registerConfigReferenceGuard：查询全部模板步骤表单行，不限当前版本，返回可读 409 FORM_IN_USE；外键 restrict 不变。
- 流程头部与全部历史版本、角色、评价规则、模块等级、模块字段，以及既有结果规则 / 表单快照字段与人才标准守卫继续生效。清空当前版本不释放历史引用，删除模板后子表级联清理。
- DEC-436：九宫格 / 计算规则的项目引用归 #256；实际盘点对象 → 模板守卫与外键归 PR-C。configReferrer('template') / TEMPLATE_IN_USE 只测登记契约，不计真实项目 / 对象覆盖。

## 写入口与披露

| 写入口 | 人工输入 | 沿用 / 系统值 | 当前权限复核 |
| --- | --- | --- | --- |
| 复制 | name、原件 revision、命令 ID | 冻结模块与公式；新 ID / 版本 / 创建人；停用与空流程默认值 | ledgerExit → guard.before：对象、copy 按钮、name 编辑权、原件范围、目录权；服务行锁后再验范围与 revision |
| 复制重放 | 原请求 | 台账的原复制件；不新增版本 | before 再验原件和目录，replayed 再验复制件当前归属与历史回执持有的引用范围；公式 / hints / 嵌套响应用既有投影 |
| 启停 / 删除 | enabled 或无字段 | revision、同事务审计 | B6a 原路径不变；拒绝时整体回滚 |

查看人 × 响应：模板字段按当前查看权裁剪，公式中的字段名 / ID 按当前字段目录权限投影，无目录查看权不披露绑定；无对象权或按钮 403，范围外 404。

## 验收与 F-039

- `AC-TR-template-copy`：复制字段、快照与结果绑定、独立改名 / 删除、默认值、启停、命令冲突、当前 / 历史配置拒删、模板引用扩展点契约。
- `AC-TR-template-copy-permissions`：真实授权器下无对象权 / copy 按钮 403、范围外 404、撤权重放拒绝、业务不变。
- `AC-TR-template-copy-pg`：真实 HTTP 事务持锁，两种先后顺序的复制 × 原件编辑、表单删除 × 模板新增引用。
- 路由在 template-policy.ts 声明、required/talent-review.ts 登记义务；重算冻结基准、发现探测与证据摘要。不改 evidence-core.ts / core-digests.ts。
- 授权目录新增 copy 按钮，按 DEC-404 顺延版本与指纹；不新增对象、迁移或预置看全部项。
