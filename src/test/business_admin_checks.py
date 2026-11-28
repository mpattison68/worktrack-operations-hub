"""No network or live SQL: unit checks of guarded administration planning."""
import sys
sys.dont_write_bytecode=True
import contextlib,datetime,importlib.util,io,json,pathlib,tempfile,unittest,types
spec=importlib.util.spec_from_file_location('business_admin',pathlib.Path('deploy/scripts/business-admin.py'))
if spec is None or spec.loader is None:raise RuntimeError('Missing administration module')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Checks(unittest.TestCase):
 def test_allowlist(self):
  original=m.rows;m.rows=lambda sql:[{'table_name':n} for n in ['payroll_earnings','job_revisions','worker_rate_overrides','unrelated_customer_table','accounts']]
  try:self.assertEqual(set(m.tenant_tables()),{'payroll_earnings','job_revisions','worker_rate_overrides'})
  finally:m.rows=original
 def test_verified_roster(self):
  self.assertEqual(len(m.WORKERS),13);self.assertEqual(len(m.ROAD),11)
  self.assertEqual({r:sum(1 for w in m.WORKERS if w[2]==r) for r in ['supervisor','road_worker','cook']},{'supervisor':1,'road_worker':11,'cook':1})
 def test_dry_run_has_no_writes(self):
  original=m.query;m.query=lambda _:(_ for _ in ()).throw(AssertionError('Dry import attempted SQL'))
  try:
   with contextlib.redirect_stdout(io.StringIO()):m.import_workers(types.SimpleNamespace(effective_from='2026-11-01',execute=False))
  finally:m.query=original
 def test_repeatable_import_amounts_and_conflict_assertions(self):
  original=(m.query,m.verify_backup,m.assert_clean_start,m.verify);batches=[]
  def query(sql):
   if sql.startswith('SELECT count'):return '0'
   batches.append(sql);return ''
  m.query=query;m.verify_backup=lambda _:None;m.assert_clean_start=lambda _:None;m.verify=lambda _:None
  a=types.SimpleNamespace(effective_from='2026-11-01',execute=True,confirm='IMPORT VERIFIED 13 WORKERS',backup='isolated-test-only',actor='11111111-1111-4111-8111-111111111111',normal_hours=9,workdays=5,cook_policy='prorated_by_days')
  try:
   with contextlib.redirect_stdout(io.StringIO()):m.import_workers(a);m.import_workers(a)
   self.assertEqual(batches[0],batches[1]);self.assertIn("'daily',25000,9,5",batches[0]);self.assertIn("'weekly',50000,9,5",batches[0]);self.assertIn('Import pay terms conflict',batches[0]);self.assertIn('Existing import identity differs',batches[0]);self.assertNotIn('INSERT INTO payroll_runs',batches[0]);self.assertNotIn('INSERT INTO journal_entries',batches[0])
  finally:m.query,m.verify_backup,m.assert_clean_start,m.verify=original
if __name__=='__main__':unittest.main()
