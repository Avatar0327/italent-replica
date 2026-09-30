> 当前口径（2026-09-08新增细化）：P1A/P1B均未验收；只推进盘点、需求及差异分析。唯一总控，E2不增人，多人UAT不阻断P1；D1–D7不重问。当前路标见HRIS_Project_Plan，事实源Scope_Register.json，队列v5。以下“本轮测试/已完成/后续开发”保留其原历史版本与适用范围，不代表当前复验；本文旧阶段建议不覆盖最新检查点。

# 当前有效：P1唯一总控（2026-09-08T14:14:15.632554+00:00）

当前聊天唯一执行与文档写入者；只读原站并整理P1，暂停新功能，不启用历史模块分工、分支领取或代理。保留48组与既有分支。Module_Queue.json v4、Controller_Resume.md和P1_Review.md为当前入口；F01–F04人工验收不是前置。以下均为历史，不授予其他聊天写入权。

---

# 文件归属与写入交接

## 当前生效：单聊天连续执行 / H004-R

用户已确认回归单聊天；04已明确交还写入职责。总控核对干净分支后将 ca5f82af7fee4a29789ba969ea070a5cd3544307 快进合入main，无冲突。本聊天为唯一代码、共享接口及文档写入者和合并发布者。H005–H008不再向其他聊天自动激活，预建分支与全量范围保留，由总控依次处理。以下旧交接/自动激活描述仅为历史，以本节及Module_Queue.json v2为准。

H004报告122/122、类型检查和构建通过；总控复测另记，人工业务与生产未验收。当前重点：绩效展示一致性，然后干部/学习原站证据与逐项差异，先做深再扩展。


当前模式：H004将唯一代码写入职责交给04绩效管理（本交接及分支推送后生效）；总控保留合并/发布。H005–H008已预分配并排队，不能提前写入。最新Module_Queue.md及json为当前队列，覆盖以下历史状态。

## 历史交接：H001（已关闭）（2026-09-07）

01 基础与组织员工已完成只读接入，用户转交结果与总控实查一致：基线 c34c557245eae4e63a21c9dd4a0e006f99f89723，main干净。总控在本交接提交保存并推送后释放代码写入职责；01基础成为唯一代码写入者，无需再次等待总控或用户确认。总控在其交还前不修改应用或并发执行写入；合并、发布仍由总控负责。干部和学习包保持未领取。

分支：delivery/foundation，从包含H001的主线提交创建；若总控已建立同名分支，先核对其基线再切换，不能强制覆盖。共用当前检出目录的串行模式，不代表并行隔离通过。01基础可以自行切换此分支、提交；不推送main、不调用发布操作。保持本地提交并交付完整SHA；无法共享本地对象时交付git补丁，由总控集成。

### 本轮明确允许修改

- 基础领域：lib/hris/model.ts、authorization.ts、context.ts、repository.ts、http.ts、member-rules.ts、development-repository.ts；仅G0确切缺口的兼容性修复。
- 基础API：app/api/hris/、app/api/members/、app/api/access/、app/api/attachments/。
- 验证：tests/hris.test.mjs、tests/authorization.test.mjs、tests/workflows.test.mjs、tests/p2-api.test.mjs、tests/p3-api.test.mjs、tests/support/；可新增tests/g0-*.test.mjs与tests/g1-*.test.mjs，合成数据限定于本地测试。
- 记录：docs/delivery/modules/foundation.md、docs/delivery/acceptance/G0.md、G1.md；可新增docs/delivery/G0_*.md和G1_*.md及合成测试结果文件。
- docs/delivery/Shared_Contracts.md允许澄清现有契约与证据，不自行改变跨模块业务语义。

以上共享基础和测试文件本轮明确交给01基础单写，不再逐文件申请。保持其余模块既有测试和功能，避免为消除测试失败降低断言。

### 保留给总控的变更

lib/hris/development.ts、app/api/development/route.ts、migrations/、UI壳、身份集成、依赖/构建/托管配置、其他业务模块及范围/归属/发布文件。若G0需要调整，先在G0记录中给出具体补丁建议和原因，推进其他无依赖任务；交付时由总控集中处理。不为推测性需求改全局架构。

工作范围仍为F-G0-01至04：证据映射、契约异常验证、合成场景、G1贯通方案及必要精确修复。优先复用已有109项测试，不需为领取机械重跑全部测试。退出：提交变更和测试证据、G0结论、遗留项、下一动作，明确交还写入职责；生产与人工业务验收不得代签。

| 范围 | 责任角色 | 文件 |
|---|---|---|
| 共享基础与模型 | 总控暂兼基础负责人 | lib/hris/model.ts、authorization.ts、context.ts、repository.ts、development.ts、development-repository.ts、http.ts、member-rules.ts；migrations/全部 |
| 公共接口与壳 | 总控 | app/api/development/route.ts、app/hris.tsx、app/chatgpt-auth.ts、components/、app/globals.css、package文件、构建及托管配置 |
| 共用测试与报表 | 总控 | tests/p3-api.test.mjs、tests/support/、lib/hris/reports.ts、app/reports/、范围进度文件 |
| 基础模块候选 | 01基础（领取后） | app/api/hris/、members/、access/、attachments/；组织员工相关专属文件，领取前列明实际路径 |
| 干部专属候选 | 02干部（领取后） | lib/hris/cadres.ts、cadre-profiles.ts、qualification.ts；app/cadres/、cadre-profiles/、qualifications/及对应API |
| 学习专属候选 | 03学习（领取后） | lib/hris/training-*.ts、learning-credits.ts；app/learning/、training-requests/、training-sessions/、learning-credits/及对应API |
| 交付与验收记录 | 总控汇总，模块提议 | docs/delivery/及Execution_Checkpoint.md |

接入规则：新聊天先只读核对项目ID、完整SHA、工作区干净状态、交接文件；报告给总控。总控保存交接点并释放写入职责后，新聊天才能作为串行接手者写代码。它只交付提交和证据，总控恢复后统一合并/验证/发布。未领取时无模块写入权限分配。

即使本机worktree探针通过，也不宣布跨聊天隔离通过。未经核实前，其他聊天只做资料盘点、方案或补丁建议，不触碰活动检出目录。Sites技能的站点所有者规则继续适用；不将站点编辑/发布委派给生成的子代理。本轮不创建代理。

合并流程：核对基线→检查允许路径/共享变更→记录兼容性→串行合并→必要集成验证→更新台账→总控私有发布。保留原提交；不重置或覆盖他人未提交修改。数据库迁移由总控统一编号和测试。凭据不得写入交接文件。

## H001-R：总控接回（2026-09-07，当前生效）

基础交付bc8422893d890144462c3424f08c82e81a95152f，测试提交ad197fff5fefa3d6361a464a213efbe1a9d5f78a。已核对11个变更文件均在H001允许范围，原有109项测试与应用源码未修改，工作区干净；基础包已明确交还。

总控接受G0限定技术门槛通过：原报告114/114，9个源文件哈希一致，总控复跑新增5项通过。已快进合并到main，保留delivery/foundation作为交付追溯分支，不再用于持续写入。01基础的H001写入职责终止，总控恢复唯一代码写入。干部和学习需下一次明确交接，尚未自动获得写入职责。G1/G4未验收。

## H002 历史交接（已关闭）：02干部人才串行写入交接

2026-09-07。接入报告正文的cadre.md、delivery/cadre、C-G1-01至04均指向02干部人才，尽管用户转贴标题写03学习。总控按干部工作包办理；本交接仅适用于“02 干部人才”聊天，03学习不得据此领取或写入。报告核查基线859ef30facb1bc1aed76d9b0b8026ed054315251与总控当前main干净状态一致。

本交接提交保存并推送后，总控释放代码写入职责给02干部，交还前不并发修改应用。总控保留合并/发布职责。01已结束；03仅只读研究，不写文件、不切换共享工作区分支、不运行会修改共享产物的测试/构建。

02从包含H002的主线提交创建delivery/cadre（当前尚未创建）；若已存在先核对，不强制覆盖。共享目录串行切换，不承诺多聊天隔离。直接执行C-G1-01至04，不再重复等待领取批准。只交付本地提交和证据，不推送main或发布。

### 明确允许路径

- lib/hris/cadres.ts、cadre-profiles.ts、qualification.ts；限定首批C01/C02确切缺口的兼容修复。
- app/cadres/、app/cadre-profiles/、app/qualifications/及app/api/cadres/、app/api/cadre-profiles/、app/api/qualifications/；先核对现有目录，不创建替代架构。
- tests/g1-cadre*.test.mjs可新增；tests/g1-foundation.test.mjs、tests/support/foundation-scenario.mjs允许补充复用场景，保持既有断言。可新增tests/support/cadre-*.mjs。
- docs/delivery/modules/cadre.md、docs/delivery/acceptance/G1.md；可新增docs/delivery/G1_Cadre_*证据、运行结果与交接记录。
- docs/delivery/Shared_Contracts.md仅追加现有实例/证据与待决议项，不自行改变接口语义。

### 总控保留路径与业务边界

lib/hris/development.ts、app/api/development/route.ts、公共权限/持久化、migrations/、tests/p3-api.test.mjs、tests/support/runtime.mjs、身份、依赖/构建/托管、UI壳、学习业务和归属/检查点/范围文件由总控保留。需要改动时在G1_Cadre记录提供具体补丁建议、失败证据和影响，推进其他无依赖项，不绕过权限或修改断言掩盖问题。

重点：复用已通过X01正常链，补HR完成前后档案、跨组织拒绝、经理经历隔离、离职后计划/学习/历史的组合验证。离职后HR是否应保留历史由现有权限与企业规则分别标明，不能一概强制所有角色403，也不能将未核实保留策略冒充原站制度。保持学习完成不自动变更岗位、资格、任命。

退出：C01/C02及C-G1任务有精确证据、提交SHA、测试结果、待核实项与保留路径建议，明确交还写入职责。仅干部侧交付，G1整体还需学习组合和人工业务验收；不得提前签署G1/G4。合成数据与既有只读/授权边界继续有效。

## H002-R 总控接回
02交付420edae82648bb0a103e169843be2d66dc737f7b，已明确交还，main快进合并。总控修复C-DEF-01并跑115项回归通过，详见C_DEF_01_Resolution.md。干部侧核查交付接受，但G1整体仍未验收。

## H003 历史交接（已关闭）：03学习发展串行交接

03已提供只读接入报告，旧报告基线859ef30；现需读取包含本记录的新主线，已有账号/目标/模块顺序授权无需重问。干部H002已明确交还并合入，总控完成C-DEF-01修复。总控在本交接提交保存推送后释放代码写入职责给03，保留合并和发布；01/02不继续写入。

03从包含H003的主线创建delivery/learning，存在则核对基线，禁止强制覆盖。仍是共享目录串行交接，不宣布并行隔离通过。只提交模块代码及证据，不推送main、不发布、不新建站点。

允许路径：lib/hris/training-stages.ts、training-dispatch.ts、training-sessions.ts、training-requests.ts、learning-credits.ts；app/learning/、training-sessions/、training-requests/、learning-credits/及相应专属API目录。仅确切的首批缺口修复，不重做现有实现。

允许测试：新增tests/g1-learning*.test.mjs、tests/support/learning-*.mjs；允许兼容扩展tests/support/foundation-scenario.mjs，但保留基础/干部测试断言。已有g0/g1/p3测试可执行，tests/p3-api.test.mjs和runtime.mjs不改，使用新增模块测试承载新证据。

允许记录：docs/delivery/modules/learning.md、acceptance/G1.md、新增G1_Learning_*文档/测试结果；Shared_Contracts.md只追加实例和证据。Ownership、检查点、范围由总控更新。

保留路径：development.ts及app/api/development/route.ts、公共权限/持久化、cadre-profiles、migrations、身份、依赖、构建/托管、UI壳。确切缺陷提交复现与补丁建议给总控，不绕过校验，不为让测试通过放宽预期；期间推进其他项。

任务：L-G1-01直接引用已通过人员/版本/计划异常证据，不重复编写；L-G1-02/03重点用同一合成员工场景关联planId和trainingId、两个课程阶段、考试、强制出勤、独立核验、取消恢复和学分去重/撤销，检查人才档案状态。使用独立验证者及当前组织权限。L04先完成历史课程复用设计，保留后续，不冒称已实现。

C-DEF-01新基线已修复，旧干部6/6报告仅是历史现状，不能恢复400缺陷断言。115项回归为当前修复基线；不将测试数当作全量完成率。仅合成数据，无原站写入/真实迁移/扩大访问。

完成模块交付时给出完整SHA、测试命令和证据、G1对应项状态、未知规则与遗留缺陷，并明确交还写入职责。G1人工业务及生产验收不得代签。完成小功能继续工作，无需重复请求继续。

## H003-R 当前生效：学习交付接受与总控接回
交付3df999911851dcbbf273bcc9c0571f85b4554a58，测试提交dd1044e3afba0c3ba249fc92a75b33a5812da3f8。7个文件均为允许范围的测试/文档，无应用源码变更。95/95所选集合报告与5个源哈希吻合；总控复跑学习及干部停用2/2通过。工作区干净，main快进合并，无冲突。03明确交还，H003关闭；总控接回全部写入职责，G1整体未签署，不自动启动新模块或代理。

## H004–H008预分配（当前生效规则）
当前H004允许路径与任务详见modules/performance.md；H005–H008详见各模块包和Module_Queue。04可以直接领取，无需第二轮批准。队列激活只有一名写入者，其余仅聊天内只读分析。总控提交推送后释放代码写入，04交还前不并发修改应用。分支创建不授予发布权，其他包前置条件和快进基线处理见Module_Queue。
