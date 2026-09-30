"""Prepare a fixed-source review receipt; this is documentation, not a business test."""
import copy, datetime, hashlib, json, pathlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[4]
P = ROOT / 'docs/delivery/r1-p3'
SOURCE = 'de053be59cc0e08c2044fb534ef46ee085a38203'
OLD = '76a16265fdd65f6ba7608260dde1e07acfb85200'
NEW = '7920b64ea30f1e4b232fb86bba2742852d0892e8'
ORIGIN = 'docs/evidence/original-site/r1/'
RUN = 'evidence/r1-p3-20260911T005747815482Z.json'
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat()
def git(*args): return subprocess.check_output(['git', *args], cwd=ROOT)
def read(name): return json.loads((P/name).read_text())
def write(name, value): (P/name).write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
def origin(head, name): return json.loads(git('show', head+':'+ORIGIN+name))
def digest(data): return hashlib.sha256(data).hexdigest()
assert git('rev-parse','HEAD').decode().strip() == SOURCE
run = read(RUN)
assert run['sourceSha'] == SOURCE
assert run['testSummary']['pass'] == 185 and all(c['exitCode']==0 for c in run['checks'])
for c in run['checks']: assert digest((P/c['log']).read_bytes()) == c['sha256']

# Receive only changed source rows. The previous immutable receipt remains historical.
changed = git('diff','--name-only',OLD,NEW,'--',ORIGIN).decode().splitlines()
inputs = []
for path in changed+[ORIGIN+'Owner_Decision_DIFF_MAJOR_001_20260910.json']:
    raw = git('show',NEW+':'+path)
    if path.endswith('.json'): json.loads(raw)
    inputs.append(dict(path=path,head=NEW,sha256=digest(raw),bytes=len(raw),blobId=git('rev-parse',NEW+':'+path).decode().strip()))
delta=[]
for name, key, identity, group in [('R1_Original_Behavior_Matrix.json','cases','caseId','behavior'),('R1_Parity_Difference_Ledger.json','entries','id','ledger'),('Future_Date_Recovery.json','steps','id','future')]:
    before={x[identity]:x for x in origin(OLD,name)[key]}
    for row in origin(NEW,name)[key]:
        if row==before.get(row[identity]): continue
        rid=row[identity]
        report = 'REPORT' in rid or rid.startswith('M32-') or rid=='ENV-05'
        rehire = 'REHIRE' in rid
        template = rid=='OBS-07'
        routing = rid=='OBS-05'
        files=['tests/r1-p3-report-query.test.mjs','tests/r1-p3-report-oracles.test.mjs'] if report else ['tests/r1-p3-m01.test.mjs','tests/r1-p3-transfer.test.mjs']
        code=['lib/hris/r1-report-m01-producer.ts','lib/hris/r1-report-query.ts'] if report else ['lib/hris/r1-m01.ts']
        if routing:
            code+=['lib/hris/r1-workflow.ts']
            files=['tests/r1-p3-workflow.test.mjs']
        cases=['P3-M32-01','P3-M32-02','P3-M32-03'] if report else ['P3-M01-02'] if rehire else ['P3-M01-08','P3-M01-09'] if template else ['P3-M19-01'] if routing else ['P3-M01-10']
        requirements=['M32-SPEC-01','M32-SPEC-02','M32-SPEC-04'] if report else ['F-SPEC-01','F-SPEC-05','F-SPEC-06'] if rehire else ['F-SPEC-07'] if template else ['M19-SPEC-01','D7'] if routing else ['F-SPEC-05','F-SPEC-06','D1','D7']
        disposition = ('接收报表交互仍受限；当前/历史结果未知，旧2人及预期1人均不得填为本次结果。' if report else
            '接收未执行再入职；离职状态已证实，但旧雇佣段结束审计/正式入口/邀请否未核，不自动解除前置。' if rehire else
            '接收源窗口静态观察；既有显式必填空白修复本轮完整回归通过；新增日期/试用规则仍仅提案。' if template else
            '接收源TransferProcessNew匹配DimissionProcessNew的配置观察；不复制错位摘要/路由，不认定P3缺陷。' if routing else
            '接收实际离职/逐单终态的局部观察；按批准规则保留执行时间、原单、退出代次与有界清理；不是整链MATCH。')
        delta.append(dict(id=rid,group=group,sourcePath=ORIGIN+name,sourceRecord=row,change='updated' if rid in before else 'added',
            approvedRequirementIds=requirements,designHead='e15237281ff19f04f08a354fd9455c518b24ae47',
            implementation=dict(sourceSha=SOURCE,paths=code),tests=dict(files=files,plannedCases=cases,currentRun=RUN,scope='本轮实际本地合成测试；原站未执行条件与独立验收不计通过'),
            disposition=disposition,implementationDefectConfirmed=False,independentReview='pending'))
assert len(delta)==11, len(delta)
future=origin(NEW,'Future_Date_Recovery.json')['manualRecheck']
receipt=dict(kind='incremental_origin_receipt_not_independent_acceptance',receivedAt=NOW,previousReceipt='R1_P3_Origin_Evidence_Intake.json',previousSourceHead=OLD,sourceHead=NEW,
    implementationReviewedHead=SOURCE,readMechanism='git show pinned objects only; no browser/CDP',sourceInputs=inputs,
    counts=dict(changedSourceFiles=len(changed),newBehaviorRows=3,updatedBehaviorRows=1,updatedLedgerRows=3,updatedFutureSteps=4,mappingRows=len(delta)),
    countRule='11条有交叠的增量映射，不是11项新增测试；既有70行为/15台账/4恢复89条回执不重复接收；新矩阵共73行为，台账仍15。',
    mappings=delta,currentFacts=future,
    ownerDecision=dict(id='OWNER-DIFF-MAJOR-001-20260910',unchanged=True,D1toD7Retained=True),
    interpretation=['状态由新查询证实，不是由日期推定。离职实际执行人/审计时间仍null。','调动终止时间2026-09-11T01:15+08:00仅分钟精度，不补秒，不挪作离职执行时间。','原单/流程ID相同；离职版本与原单直接字段链接未显示。','P3支持已批准原单执行和有界逐单清理；不据源系统定时终止替换D7授权HR执行，也不复制源状态标签/9999年哨兵。','ROLE-01、其他未测源行为与SRC13责任继续保留；ENV-05局部恢复，不再称全业务不可读。'],
    currentLocalRun=RUN,newImplementationDefects=[],newProductChanges=[],p3ExitApproved=False,p4Started=False)
write('R1_P3_Origin_Increment_7920b64.json',receipt)

# Pin the observational dependency snapshot. No claim that all cloud resources were inventoried.
producer=read('R1_P3_Producer_Case_Evidence.json')
refs={'main':'22be3a7e366d6787180d4f593a30f5984c70e03a','design/r1-p2-20260909':'e15237281ff19f04f08a354fd9455c518b24ae47','design/r2-p2-20260910':'a7a23d6bff024f4660fd14b0c22f47a6d40d928f','review/r2-p2-exit-20260910':'077e0dc7f37529b9585f030fb1c8460f4c884cd1','evidence/r1-origin-parity-20260910':NEW,'impl/r1-p3-20260910':SOURCE}
dep=dict(kind='read_only_dependency_snapshot_not_runtime_proof',observedAt=NOW,sourceSha=SOURCE,remote='r1-p2-origin',method='authenticated git ls-remote --heads, shared fixed Git objects, Sites get_site/get_environment_variables; metadata only',observedHeads=refs,
    repositoryFindings=['远端所有分支列表无R2/R3 P3实施分支；旧delivery分支不是已批准的新P3契约。','R2最新独立定向复核通过，可提交所有者；P2退出/P3准入仍未发生，46任务和138场景未开始/未执行。旧不通过段落不作最新结论。','R2可按能力冻结基线启动获准子片段，不把全部R1退出设为循环前置。R3当前有原站补证分支，没有P3源码/运行交接。'],
    producerCases=[dict(id=c['id'],producer=c['producer'],owner=c['owner'],approvedRuntimeVersion=None,actualP3SourceSha=None,isolatedRuntimeEvidence=None,status='not_ready_evidence_not_supplied',nextAction='生产者负责人提供批准契约版本+实际P3固定SHA+隔离启动/复位方式+合成数据集+预期逐字段结果；R1只续此契约联调') for c in producer['cases'] if c['execution']=='blocked_real_producer_not_ready'],
    platform=dict(site=dict(id='appgprj_6a9e2c705cfc819180e0e5251bb025cc',version=112,updatedAt='2026-09-08T13:43:27.542661+00:00',accessMode='custom',externalVisitorCount=0),
        environment=dict(revision=1,updatedAt='2026-09-07T03:42:24.537360+00:00',keys=['HRIS_SETUP_OWNER_EMAIL'],valuesRecorded=False),
        localBindings={'d1':'DB','r2':'BUCKET'},workerEntry='worker/index.ts: fetch only; no scheduled/queue handler',securityRuntime='lib/hris/r1-security-runtime.ts: needs R1_REQUIRE_SECURITY_LEDGER=1 plus independent R1_SECURITY_RUNTIME and R1_SECURITY_PUBLIC_KEY',
        conclusion='未发现新增能力证据；仅业务DB/BUCKET声明及站点元数据，不能证明独立资源、云端一致cut、调度、独占维护或可信当前访问；未查全平台资源，不推断资源绝对不存在。',nextActions='R1_P3_Platform_Actions.md'),
    resourcesCreated=0,deployments=0,accessChanges=0,realExternalEffects=0)
assert len(dep['producerCases'])==16
write('R1_P3_Current_Dependency_Check.json',dep)
producer['latestReadinessCheck']='R1_P3_Current_Dependency_Check.json'
producer['latestConsumerRegression']=dict(sourceSha=SOURCE,evidence=RUN,meaning='消费者和3项实际R1内部合成路径复验；16真实生产者仍未执行，不改历史realEvidence或accepted')
write('R1_P3_Producer_Case_Evidence.json',producer)

checkpoint=read('R1_P3_Checkpoint.json')
checkpoint['currentActivity']='fixed_version_review_prepared_no_active_implementation_external_dependencies_blocked'
checkpoint['latestOriginIncrement']=dict(sourceHead=NEW,receipt='R1_P3_Origin_Increment_7920b64.json',previousSourceHead=OLD)
checkpoint.setdefault('originReceiptHistory',[checkpoint['latestOriginIntake']])
checkpoint['latestOriginIntake']=dict(sourceHead=NEW,receipt='R1_P3_Origin_Increment_7920b64.json',summary='R1_P3_Origin_Evidence_Intake.md',verification=RUN,status='increment_received_review_pending')
checkpoint['currentReview']=dict(sourceSha=SOURCE,evidence=RUN,packet='R1_P3_Review_Packet.md',manifest='R1_P3_Fixed_Review_Manifest.json',independentReview='pending')
for task in checkpoint['tasks']: task['currentReviewEvidence']=dict(sourceSha=SOURCE,evidence=RUN,meaning='关联测试文件已在本轮完整本地套件执行；不覆盖未执行的原子条件、真实联调、平台或独立签署')
write('R1_P3_Checkpoint.json',checkpoint)
trace=read('R1_P3_Traceability.json')
trace['latestEvidence']=[RUN]
trace['currentReview']=checkpoint['currentReview']
trace['originEvidenceIncrement']='R1_P3_Origin_Increment_7920b64.json'
for ac in trace['acceptance']:
    ac['latestOverallRevalidation']=RUN
    ac['overallRevalidationNote']='2026-09-11固定de053be的一轮完整R1本地185项；关联代码/文件复验，不将原AC全部子条件或独立验收自动置通过。'
for risk in trace['risks']:
    cases=risk['plannedP3Cases']; phase=risk['primaryDisposition']; module=risk['id'].split('-')[1]
    risk['currentReviewDimensions']=dict(
        localVerified=dict(evidence=RUN,sourceSha=SOURCE,meaning='关联用例文件本轮复验；逐子条件以caseEvidenceFiles为准，非整项风险通过'),
        independentReview='P2设计已由所有者关闭，新增运行证据待独立复核' if phase=='P2' else 'pending_not_signed',
        realIntegrationGap='16真实生产者缺口对相关跨域条件保留，详见Producer_Case_Evidence；不以消费者负向测试关闭' if module in ['M48','M32'] else '外部供应商/跨域取消未实联，适用条件见原场景；不以模拟关闭',
        platformGap=['DEP-PLATFORM-01','DEP-PLATFORM-02'] if any(x.startswith('P3-REC') for x in cases) else ['DEP-PLATFORM-01'] if any(x in ['P3-M32-06','P3-M32-08','P3-M32-09'] for x in cases) else [],
        originEvidence=dict(owner='P1总控',receipt='R1_P3_Origin_Increment_7920b64.json',meaning='仅局部增量；SRC13未整体关闭'),
        p4HumanAcceptance='retained' if phase=='P4' else '相关独立人工条件不由本地测试替代；不改变本风险原阶段')
write('R1_P3_Traceability.json',trace)
deps=read('R1_P3_Dependencies_Decisions.json')
deps['latestReadinessCheck']='R1_P3_Current_Dependency_Check.json'
deps['platformActionList']='R1_P3_Platform_Actions.md'
deps['latestOriginIncrement']='R1_P3_Origin_Increment_7920b64.json'
deps['ownerDecisionRequiredNow']=False
deps['authorizationRequestsPrepared']=dict(status='prepared_not_executed',document='R1_P3_Platform_Actions.md',blocks='无现成已授权资源时阻平台真实验证；不阻固定版本独立评审')
for d in deps['dependencies']:
    if d['id'].startswith('DEP-PLATFORM'): d['readOnlyCheck']='R1_P3_Current_Dependency_Check.json'; d['minimumAction']='R1_P3_Platform_Actions.md#'+d['id'].lower()
    if d['id']=='DEP-PRODUCERS-01': d['impact']='10仍16真实生产者未完成；11本地检查点及本轮185项回归不代替真实联调'; d['readOnlyCheck']='R1_P3_Current_Dependency_Check.json'
write('R1_P3_Dependencies_Decisions.json',deps)
proposal=read('R1_P3_Controller_Proposal.json')
proposal['currentReview']=checkpoint['currentReview'];proposal['latestOriginIncrement']='R1_P3_Origin_Increment_7920b64.json'
proposal['latestEvidence']=RUN
proposal['latestFreshEvidence']=RUN
proposal['latestTaskEvidence']=[RUN]
proposal['latestVerifiedSourceSha']=SOURCE
proposal['testEntriesPassed']=185
proposal['latestTestSummary']=run['testSummary']
proposal['latestTaskCaseEvidence']='R1_P3_Fixed_Review_Packet.md'
proposal['currentActivity']=checkpoint['currentActivity']
proposal.setdefault('originReceiptHistory',[proposal['latestOriginIntake']])
proposal['latestOriginIntake']=checkpoint['latestOriginIntake']
proposal['latestTaskBoundaries']=['固定de053be一轮185项完整本地回归+类型+构建；无新产品修改，不沿用历史计数','原站7920b64增量接收：离职状态/调动终止已观察；离职执行审计、报表、再入职与独立角色仍缺证','D1–D7及即时调动有意差异不变；16真实生产者和平台01/02仍阻塞；待独立复核，未批准P3退出/P4']
write('R1_P3_Controller_Proposal.json',proposal)
print(json.dumps(dict(source=SOURCE,increment=NEW,mappings=len(delta),changedSourceFiles=len(changed),tests=run['testSummary']),ensure_ascii=False))
