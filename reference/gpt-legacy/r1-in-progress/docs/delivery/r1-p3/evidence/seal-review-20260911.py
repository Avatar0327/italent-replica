"""Hash and cross-check review artifacts. Not independent review or product tests."""
import collections, datetime, hashlib, json, pathlib, re, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[4]
P=ROOT/'docs/delivery/r1-p3'
SOURCE='de053be59cc0e08c2044fb534ef46ee085a38203'
NEW='7920b64ea30f1e4b232fb86bba2742852d0892e8'
RUN='evidence/r1-p3-20260911T005747815482Z.json'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def read(path):return json.loads((P/path).read_text())
def sha(data):return hashlib.sha256(data).hexdigest()
def write(path,data):(P/path).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
checks=[]
def check(label,result):
    checks.append(dict(check=label,passed=bool(result)))
run=read(RUN); checkpoint=read('R1_P3_Checkpoint.json'); trace=read('R1_P3_Traceability.json'); intake=read('R1_P3_Origin_Increment_7920b64.json'); producers=read('R1_P3_Producer_Case_Evidence.json')
check('current source identity',git('rev-parse','HEAD').decode().strip()==SOURCE)
changes=git('diff','--name-only',SOURCE).decode().splitlines()
check('only P3 delivery files changed',all(x.startswith('docs/delivery/r1-p3/') for x in changes))
check('run source',run['sourceSha']==SOURCE)
check('actual TAP counts',run['testSummary']=={'tests':185,'pass':185,'fail':0,'cancelled':0,'skipped':0})
log=(P/run['checks'][0]['log']).read_text()
for value in ['tests 185','pass 185','fail 0','skipped 0','cancelled 0']:
    check('Node reporter '+value,re.search(r'^(?:#|ℹ) '+re.escape(value)+r'$',log,re.M) is not None)
check('17 R1 files executed',len([x for x in run['checks'][0]['command'] if x.startswith('tests/r1-p3')])==17)
for c in run['checks']:
    check(c['name']+' exit',c['exitCode']==0)
    check(c['name']+' log hash',sha((P/c['log']).read_bytes())==c['sha256'])
for path,expected in run['inputs'].items():
    check('test input '+path,sha((ROOT/path).read_bytes())==expected and sha(git('show',SOURCE+':'+path))==expected)
check('P3 exit unapproved',not checkpoint['exitApproved'] and not checkpoint['p4Started'] and not checkpoint['allElevenTasksComplete'])
check('11 tasks preserved',len(checkpoint['tasks'])==11)
check('task10 still blocked',next(x for x in checkpoint['tasks'] if x['id']=='P3-R1-10')['status']=='partial_internal_verified_producer_blocked')
check('37 risk dispositions unchanged',dict(collections.Counter(x['primaryDisposition'] for x in trace['risks']))==dict(P2=9,P3=20,P4=8))
check('85 original AC preserved',len(trace['acceptance'])==85 and not trace['allOriginalAcPassed'])
check('no executor risk closure',trace['risksClosedByExecutor']==0)
check('latest source intake',checkpoint['latestOriginIntake']['sourceHead']==NEW)
check('old receipt immutable',git('show',SOURCE+':docs/delivery/r1-p3/R1_P3_Origin_Evidence_Intake.json')==(P/'R1_P3_Origin_Evidence_Intake.json').read_bytes())
for x in intake['sourceInputs']:check('origin '+x['path'],sha(git('show',NEW+':'+x['path']))==x['sha256'])
check('increment count',len(intake['mappings'])==11)
for m in intake['mappings']:
    for path in m['implementation']['paths']+m['tests']['files']:check(m['id']+' path '+path,(ROOT/path).is_file())
    for path in m['tests']['files']:check(m['id']+' executed '+path,path in run['checks'][0]['command'])
    for c in m['tests']['plannedCases']:check(m['id']+' planned '+c,c in trace['caseEvidenceIndex'])
facts=intake['currentFacts']
check('exit observed with audit unknown',facts['actualExitStatus'] is not None and facts['actualExitExecutor'] is None and facts['actualExitAuditAt'] is None)
check('termination minute precision',facts['transferTerminationAt']=='2026-09-11T01:15+08:00')
check('reports unknown rehire unperformed',facts['currentReportDistinctPeople'] is None and not facts['rehireAttempted'] and not facts['rehirePrerequisiteConfirmed'])
check('producer counts',producers['counts']==dict(total=22,actualR1Internal=3,r1DirectoryWithoutDataset=3,blockedRealProducer=16))
for c in producers['cases']:
    check(c['id']+' no independent acceptance',not c['accepted'])
    if c['execution']=='blocked_real_producer_not_ready':check(c['id']+' no fake runtime',c['realEvidence'] is None and c['producerSourceSha'] is None)
for r in trace['risks']:
    check(r['id']+' six dimensions',set(r['currentReviewDimensions'])=={'localVerified','independentReview','realIntegrationGap','platformGap','originEvidence','p4HumanAcceptance'})
    for f in r['caseEvidenceFiles']:check(r['id']+' case artifact '+f,(P/f).is_file())
manifestFiles=set(['R1_P3_Fixed_Review_Packet.md','R1_P3_Review_Packet.md','R1_P3_Resume.md','R1_P3_Checkpoint.json','R1_P3_Traceability.json','R1_P3_Dependencies_Decisions.json','R1_P3_Controller_Proposal.json','R1_P3_Current_Dependency_Check.json','R1_P3_Platform_Actions.md','R1_P3_Origin_Increment_7920b64.json','R1_P3_Origin_Evidence_Intake.md','R1_P3_Origin_Evidence_Intake.json','R1_P3_Write_Entrypoints.json','R1_P3_Overall_Verification.json',RUN,'evidence/prepare-review-20260911.py','evidence/seal-review-20260911.py'])
manifestFiles.update(x.name for x in P.glob('*Case_Evidence.json'))
manifestFiles.update(c['log'] for c in run['checks'])
manifestFiles.add('evidence/review-check-20260911-initial-reporter-format.json')
artifacts=[]
for path in sorted(manifestFiles):
    check('manifest file '+path,(P/path).is_file())
    if (P/path).is_file():
        raw=(P/path).read_bytes()
        if path.endswith('.json'): json.loads(raw)
        artifacts.append(dict(path='docs/delivery/r1-p3/'+path,sha256=sha(raw),bytes=len(raw)))
approvals=[]
for head,path in [('e15237281ff19f04f08a354fd9455c518b24ae47','docs/delivery/r1-p2/R1_P2_Owner_Exit_Approval.json'),('22be3a7e366d6787180d4f593a30f5984c70e03a','docs/delivery/P1_Approval_Records.md'),(NEW,'docs/evidence/original-site/r1/Owner_Decision_DIFF_MAJOR_001_20260910.json'),('e15237281ff19f04f08a354fd9455c518b24ae47','docs/delivery/r1-p2/R1_P2_P3_Handoff.md'),('e15237281ff19f04f08a354fd9455c518b24ae47','docs/delivery/r1-p2/R1_P2_P3_Start_Prompt.md')]:
    raw=git('show',head+':'+path);approvals.append(dict(head=head,path=path,sha256=sha(raw),bytes=len(raw)))
check('main registered P2 exit and P3 entry',all(x in git('show','22be3a7e366d6787180d4f593a30f5984c70e03a:docs/delivery/P1_Approval_Records.md').decode() for x in ['R1-P2-EXIT-OWNER-20260910','R1-P3-ENTRY-OWNER-20260910']))
report=dict(kind='implementation_window_artifact_integrity_check_not_independent_review_not_business_tests',at=datetime.datetime.now(datetime.timezone.utc).isoformat(),sourceSha=SOURCE,checks=checks,counts=dict(total=len(checks),passed=sum(x['passed'] for x in checks),failed=sum(not x['passed'] for x in checks)),previousAttempt='evidence/review-check-20260911-initial-reporter-format.json',previousFailureReason='5个摘要匹配检查只支持TAP #前缀；实际Node日志是ℹ前缀。已支持两种格式，原始日志及185项运行结果未修改，未重复产品测试。',independentReview='pending',p3ExitApproved=False,p4Started=False)
write('R1_P3_Current_Review_Check.json',report)
if any(not x['passed'] for x in checks):
    print(json.dumps([x for x in checks if not x['passed']],ensure_ascii=False));raise SystemExit(1)
checkRaw=(P/'R1_P3_Current_Review_Check.json').read_bytes()
artifacts.append(dict(path='docs/delivery/r1-p3/R1_P3_Current_Review_Check.json',sha256=sha(checkRaw),bytes=len(checkRaw)))
write('R1_P3_Fixed_Review_Manifest.json',dict(kind='fixed_source_review_manifest_not_independent_acceptance',createdAt=report['at'],sourceSha=SOURCE,sourceTree=git('rev-parse',SOURCE+'^{tree}').decode().strip(),branch='impl/r1-p3-20260910',reviewPacket='R1_P3_Fixed_Review_Packet.md',run=RUN,testSummary=run['testSummary'],originHead=NEW,approvalInputs=approvals,sourceInputs=run['inputs'],artifacts=artifacts,selfExcluded=['R1_P3_Fixed_Review_Manifest.json'],deliveryCommit='取包含本清单的最终Git提交及推送回执；无自引用SHA',independentReviewer=None,independentReview='pending',p3ExitApproved=False,p4Started=False))
print(json.dumps(report['counts']))
