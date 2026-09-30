"""Read-only artifact verification; test execution and acceptance remain separate."""
import collections, datetime, functools, hashlib, json, pathlib, re, subprocess

root = pathlib.Path(__file__).resolve().parents[4]
out = root / 'docs/delivery/r1-p3'
p2 = root.parent / 'italent-hris-r1-p2-20260909/docs/delivery/r1-p2'
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
checks, inputs = [], {}

def read(path):
    inputs[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return json.loads(path.read_text())

def check(name, condition, detail):
    checks.append({'name': name, 'passed': bool(condition), 'detail': detail})

@functools.lru_cache(None)
def git_bytes(ref):
    return subprocess.check_output(['git', 'show', ref], cwd=root)

trace = read(out / 'R1_P3_Traceability.json')
approved = read(p2 / 'R1_P2_Approved_Acceptance_Trace.json')['records']
limits = read(p2 / 'R1_P2_Limit_Resolution.json')['risks']
tasks = read(p2 / 'R1_P2_P3_Work_Packages.json')['tasks']
producers = read(p2 / 'R1_P2_Producer_Integration_Cases.json')['cases']
deps = read(p2 / 'R1_P2_Dependencies_Decisions.json')['dependencies']
check('85_original_acceptance_ids', len(trace['acceptance']) == 85 and
      {x['id'] for x in trace['acceptance']} == {x['id'] for x in approved}, 85)
approved_by_id = {x['id']: x for x in approved}
check('unchanged_acceptance_case_and_design_mapping', all(
    x['plannedCases'] == approved_by_id[x['id']]['plannedCases'] and
    x['designDocuments'] == approved_by_id[x['id']]['designDocuments']
    for x in trace['acceptance']), 'No approved requirement remapped or removed')
source_risks = {x['riskId']: x for x in limits}
check('37_risks_and_dispositions', len(trace['risks']) == 37 and all(
    x['primaryDisposition'] == source_risks[x['id']]['primaryDisposition'] and
    x['status'] == source_risks[x['id']]['status'] for x in trace['risks']),
    dict(collections.Counter(x['primaryDisposition'] for x in trace['risks'])))
check('13_source_requests_remain_P1', len([x for x in deps if x['id'].startswith('SRC-')]) == 13,
      'Source inspection not executed by this window')
check('no_executor_acceptance_or_risk_closure', trace['allOriginalAcPassed'] is False and
      trace['risksClosedByExecutor'] == 0, 'Independent review and P4 retained')
case_index = {}
for path in sorted(out.glob('*Case_Evidence.json')):
    for case in read(path)['cases']:
        case_index.setdefault(case['id'], []).append(path.name)
expected_cases = {c for task in tasks for c in task['caseIds']} | {x['id'] for x in producers}
check('81_design_and_producer_case_records', set(case_index) == expected_cases,
      {'expected': len(expected_cases), 'recorded': len(case_index)})
check('acceptance_code_and_case_links_exist', all(
    x.get('code') and all((root / f).is_file() for f in x['code']) and
    all(case in case_index for case in x['plannedCases']) and
    all((out / f).is_file() for f in x['caseEvidenceFiles']) for x in trace['acceptance']),
    'Structural links only; not proof that every original subcondition passed')
producer = read(out / 'R1_P3_Producer_Case_Evidence.json')
counts = collections.Counter(x['normal'] for x in producer['cases'])
check('producer_unavailable_not_passed', producer['fullTaskComplete'] is False and
      all(x['accepted'] is False for x in producer['cases']) and
      counts['passed_actual_internal_producer'] == 3, dict(counts))

records, diagnostics, log_count, input_count, errors = [], [], 0, 0, []
for path in sorted((out / 'evidence').glob('r1-p3-*.json')):
    r = read(path)
    if r.get('kind') in ['development_diagnostic_not_exact_source_verification', 'development_diagnostics']:
        for diagnostic in r.get('failures', [r]):
            log_count += 1
            if hashlib.sha256((out / diagnostic['log']).read_bytes()).hexdigest() != diagnostic['sha256']:
                errors.append(path.name + ': diagnostic log hash mismatch')
        diagnostics.append({'file': path.name, 'exactSourceVerification': False, 'countedAsPassed': False})
        continue
    source = r.get('sourceSha', r.get('implementationSha'))
    if not source:
        errors.append(path.name + ': missing source SHA')
        continue
    try:
        subprocess.check_output(['git', 'cat-file', '-e', source + '^{commit}'], cwd=root)
        for f, sha in r.get('inputs', {}).items():
            input_count += 1
            if hashlib.sha256(git_bytes(source + ':' + f)).hexdigest() != sha:
                errors.append(path.name + ': source input mismatch ' + f)
        rows = r.get('checks', r.get('results', []))
        for c in rows:
            log = out / c['log']
            if not log.is_file():
                log = out / 'evidence' / c['log']
            log_count += 1
            if hashlib.sha256(log.read_bytes()).hexdigest() != c['sha256']:
                errors.append(path.name + ': log hash mismatch ' + c['log'])
        records.append({'file': path.name, 'sourceSha': source,
                        'exitCodes': [x['exitCode'] for x in rows]})
    except (OSError, subprocess.CalledProcessError, KeyError) as e:
        errors.append(path.name + ': ' + str(e))
check('historical_evidence_integrity_not_fresh_execution', not errors,
      {'records': len(records), 'logs': log_count, 'sourceInputHashes': input_count,
       'developmentDiagnostics': diagnostics, 'errors': errors})

rounds = [read(out / 'evidence' / name) for name in
          ['r1-p3-20260910T103230203458Z.json', 'r1-p3-20260910T104045821462Z.json']]
check('two_fresh_whole_R1_rounds', all(r['testSummary'] ==
      {'tests': 183, 'pass': 183, 'fail': 0, 'cancelled': 0, 'skipped': 0} and
      {x['name'] for x in r['checks']} == {'tests', 'types', 'build'} and
      all(x['exitCode'] == 0 for x in r['checks']) for r in rounds) and
      rounds[0]['finishedAt'] < rounds[1]['startedAt'],
      [{'sourceSha': r['sourceSha'], 'runId': r['runId']} for r in rounds])
check('both_rounds_same_product_and_fixture_tree', not subprocess.check_output(
    ['git', 'diff', '--name-only', rounds[0]['sourceSha'], rounds[1]['sourceSha'], '--',
     'app', 'lib', 'db', 'drizzle', 'tests', 'scripts', 'package-lock.json', 'vite.config.ts'], cwd=root),
    'Docs-only checkpoint separates two executions')
inventory = read(out / 'R1_P3_Write_Entrypoints.json')
actual = {}
for path in (root / 'app/api').rglob('route.ts'):
    methods = re.findall(r'export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b', path.read_text())
    if methods:
        actual[str(path.relative_to(root))] = sorted(methods)
check('static_write_entrypoint_inventory', actual == {x['path']: sorted(x['methods']) for x in inventory['routes']} and
      all(hashlib.sha256((root / x['path']).read_bytes()).hexdigest() == x['sha256'] for x in inventory['routes']),
      {'routes': len(actual), 'methods': sum(map(len, actual.values())), 'dynamicCoverageClaimed': False})
check('P2_fixed_head_read_only', subprocess.check_output(
    ['git', 'rev-parse', 'HEAD'], cwd=p2, text=True).strip() == 'e15237281ff19f04f08a354fd9455c518b24ae47',
    'No P2 mutation or integration performed')
report = {'kind': 'artifact_integrity_review_not_product_test_or_acceptance', 'startedAt': started,
          'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'command': ['python', str(pathlib.Path(__file__).relative_to(root))],
          'scriptSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          'sourceSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
          'inputs': inputs, 'checks': checks, 'historicalRecords': records, 'developmentDiagnostics': diagnostics,
          'allChecksPassed': all(c['passed'] for c in checks), 'p3ExitApproved': False, 'p4Started': False}
(out / 'R1_P3_Artifact_Review.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'passed': report['allChecksPassed'], 'checks': checks}, ensure_ascii=False))
raise SystemExit(not report['allChecksPassed'])
