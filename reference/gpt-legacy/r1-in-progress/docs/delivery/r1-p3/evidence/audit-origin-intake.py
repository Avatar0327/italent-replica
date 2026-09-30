"""Audit this fixed origin intake only; never contacts a browser or executes business commands."""
import datetime, hashlib, json, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[4]
out = root / 'docs/delivery/r1-p3'
receipt = json.loads((out / 'R1_P3_Origin_Evidence_Intake.json').read_text())
source = receipt['sourceHead']
checks = []
def check(name, value, detail=None):
    checks.append({'check': name, 'passed': bool(value), 'detail': detail})
def blob(sha, path):
    return subprocess.check_output(['git', 'show', sha + ':' + path], cwd=root)
base = 'docs/evidence/original-site/r1/'
matrix = json.loads(blob(source, base + 'R1_Original_Behavior_Matrix.json'))
ledger = json.loads(blob(source, base + 'R1_Parity_Difference_Ledger.json'))
future = json.loads(blob(source, base + 'Future_Date_Recovery.json'))
check('pinned_source', source == '76a16265fdd65f6ba7608260dde1e07acfb85200')
check('all_source_blob_hashes', all(hashlib.sha256(blob(source, path)).hexdigest() == entry['sha256']
      for path, entry in receipt['sourceInputs'].items()), len(receipt['sourceInputs']))
for source_rows, received, source_key, received_key, count in [
    (matrix['cases'], receipt['behaviorMappings'], 'caseId', 'sourceCaseId', 70),
    (ledger['entries'], receipt['ledgerMappings'], 'id', 'sourceLedgerId', 15),
    (future['steps'], receipt['futureRecoveryMappings'], 'id', 'sourceCaseId', 4)]:
    check(received_key + '_coverage_' + str(count), len(received) == count and
          {x[source_key] for x in source_rows} == {x[received_key] for x in received})
trace = json.loads((out / 'R1_P3_Traceability.json').read_text())
coverage = json.loads(blob('e15237281ff19f04f08a354fd9455c518b24ae47',
                          'docs/delivery/r1-p2/R1_P2_Requirement_Coverage.json'))
rows = receipt['behaviorMappings'] + receipt['ledgerMappings'] + receipt['futureRecoveryMappings']
check('approved_requirements_and_case_links', all(set(r['approvedRequirementIds']) <= set(coverage['requiredIds'])
      and set(r['tests']['plannedP3Cases']) <= set(trace['caseEvidenceIndex'])
      and all((out / p).is_file() for p in r['tests']['caseEvidenceFiles']) for r in rows))
check('current_code_hashes_and_test_paths', all(
    all(hashlib.sha256((root / p).read_bytes()).hexdigest() == sha for p, sha in r['implementation']['sha256'].items())
    and all((root / p).is_file() for p in r['tests']['files']) for r in rows))
check('future_facts_remain_unknown', all(r['actualResult'] is None and r['dateConditionSatisfied'] is True
      for r in receipt['futureRecoveryMappings']) and receipt['currentFacts']['freshBusinessQuerySucceeded'] is False)
check('direct_transfer_owner_decision_preserved', receipt['ownerDecision']['decisionId'] ==
      'OWNER-DIFF-MAJOR-001-20260910' and receipt['ownerDecision']['classification'] == 'INTENTIONAL_DIFFERENCE')
run_refs = ['evidence/r1-p3-20260911T003553114467Z.json',
            'evidence/r1-p3-20260911T003617713648Z.json',
            'evidence/r1-p3-20260911T003733692664Z.json']
run_counts = []
for ref in run_refs:
    r = json.loads((out / ref).read_text())
    check('log_integrity_' + r['runId'], all(hashlib.sha256((out / c['log']).read_bytes()).hexdigest() ==
          c['sha256'] for c in r['checks']))
    check('exact_test_source_' + r['runId'], all(hashlib.sha256(blob(r['sourceSha'], p)).hexdigest() == sha
          for p, sha in r['inputs'].items()))
    run_counts.append((r['testSummary']['pass'], r['testSummary']['fail']))
check('failures_preserved_and_final_34_passed', run_counts == [(0, 2), (32, 2), (34, 0)], run_counts)
check('final_types_and_build_executed', {c['name'] for c in r['checks']} == {'tests', 'types', 'build'}
      and all(c['exitCode'] == 0 for c in r['checks']))
changed = subprocess.check_output(['git', 'diff', '--name-only', receipt['p3RecoveryHead'], 'HEAD', '--',
                                  'app', 'lib', 'db', 'drizzle', 'tests', 'scripts'], cwd=root, text=True).splitlines()
check('bounded_product_and_test_diff', set(changed) == {'lib/hris/r1-m01.ts', 'tests/r1-p3-m01.test.mjs'}, changed)
checkpoint = json.loads((out / 'R1_P3_Checkpoint.json').read_text())
check('external_and_phase_gates_preserved', receipt['counts']['realR2R3ProducerCasesStillBlocked'] == 16 and
      not receipt['p3ExitApproved'] and not receipt['p4Started'] and not checkpoint['exitApproved'] and
      not checkpoint['allElevenTasksComplete'] and trace['risksClosedByExecutor'] == 0)
report = {'kind': 'offline_intake_artifact_check_not_product_test_or_original_site_validation',
          'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'command': ['python', str(pathlib.Path(__file__).relative_to(root))],
          'scriptSha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
          'receiptSha256': hashlib.sha256((out / 'R1_P3_Origin_Evidence_Intake.json').read_bytes()).hexdigest(),
          'checks': checks, 'allChecksPassed': all(x['passed'] for x in checks)}
(out / 'R1_P3_Origin_Intake_Check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))
raise SystemExit(not report['allChecksPassed'])
