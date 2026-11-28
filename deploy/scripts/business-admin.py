#!/usr/bin/env python3
"""Explicit VM-only reset/import; no credentials in process arguments or logs."""
import argparse, datetime, hashlib, json, os, pathlib, subprocess, sys, urllib.request, uuid
BUSINESS='d7afd88f-4a5e-4dcd-8af9-c58e835f561e'
ROAD=['Mabhuti','Siyabulela','Simamkele','Luzuko','Luthando','Athenkosi','Akhona','Zukhanye','Nandipha','Xolani','Malibongwe']
WORKERS=[('andile','Andile','supervisor')]+[(name.lower(),name,'road_worker') for name in ROAD]+[('cook','Cook - name to be confirmed','cook')]
PRESERVE={'businesses','memberships','profiles','invitations','audit_events','worker_roles','pay_rules','notification_preferences','admin_operation_log','accounts'}
RESET_TABLES={'assessment_route_points','job_revisions','mutation_receipts','assessments','benchmarks','jobs','workers','worker_assignments','worker_rate_overrides','progress_entries','interruptions','team_days','attendance_entries','payroll_runs','payroll_earnings','payroll_adjustments','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','customer_receipts','expense_settlements','forecast_assumptions','loans','loan_events','loan_repayment_schedules','assets','asset_private','asset_checks','defects','asset_services','weekly_reports','notifications','notification_receipts','evidence_attachments','sync_idempotency_keys','funding_receipts'}
ROOT=pathlib.Path(__file__).resolve().parents[2]
def sql_literal(value): return "'"+str(value).replace("'","''")+"'"
def query(sql):
 env=os.environ.copy(); env['PGDATABASE']=env['DATABASE_URL']
 result=subprocess.run(['psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,env=env)
 if result.returncode: raise RuntimeError('Database operation failed: '+result.stderr.strip())
 return result.stdout.strip()
def rows(sql):
 raw=query('SELECT coalesce(jsonb_agg(row_to_json(x)),\'[]\'::jsonb) FROM ('+sql+') x;')
 return json.loads(raw or '[]')
def verify_admin(actor):
 if not rows(f"SELECT 1 FROM public.memberships WHERE business_id='{BUSINESS}' AND user_id={sql_literal(actor)}::uuid AND role='admin' AND active"):
  raise RuntimeError('An active Vuyo Contracting Admin actor is required.')
 if not rows(f"SELECT id FROM public.businesses WHERE id='{BUSINESS}' AND name='Vuyo Contracting'"):
  raise RuntimeError('Expected existing Vuyo Contracting business not found; no changes made.')
def verify_backup(directory):
 p=pathlib.Path(directory).resolve(); manifest=p/'manifest.json'
 if not manifest.is_file(): raise RuntimeError('Backup manifest missing. Run backup.sh first.')
 m=json.loads(manifest.read_text())
 created=datetime.datetime.fromisoformat(m['created_at'])
 if (datetime.datetime.now(datetime.timezone.utc)-created).total_seconds()>86400: raise RuntimeError('Backup is older than 24 hours.')
 if not m.get('quiesced'): raise RuntimeError('Reset/import requires a backup made with all writers stopped.')
 for name,digest in m['files'].items():
  if pathlib.Path(name).name!=name: raise RuntimeError('Unsafe backup manifest filename.')
  if hashlib.sha256((p/name).read_bytes()).hexdigest()!=digest: raise RuntimeError('Backup checksum mismatch: '+name)
 if not all(k in m['files'] for k in ['database.dump','storage.tar.gz','configuration.tar.gz']): raise RuntimeError('Backup must include database, storage and configuration.')
 if m.get('database_fingerprint')!=query("SELECT md5(current_database()||':'||(SELECT system_identifier::text FROM pg_control_system()))"):
  raise RuntimeError('Backup was made against a different database.')
 return p

def tenant_tables():
 return [r['table_name'] for r in rows("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='business_id' ORDER BY table_name") if r['table_name'] in RESET_TABLES and r['table_name'] not in PRESERVE]
def reset_plan():
 tables=tenant_tables(); counts={t:int(query(f'SELECT count(*) FROM public."{t}" WHERE business_id=\'{BUSINESS}\';')) for t in tables}
 edges=rows("SELECT child.relname child,parent.relname parent,ns.nspname child_schema FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace WHERE c.contype='f' AND pn.nspname='public'")
 for e in edges:
  if e['parent'] in tables and (e['child'] not in tables or e['child_schema']!='public'): raise RuntimeError('Unexpected preserved/external dependency; no deletion: '+str(e))
 order=[];pending=set(tables)
 while pending:
  ready=sorted(t for t in pending if not any(e['parent']==t and e['child'] in pending and e['child']!=t for e in edges))
  if not ready:raise RuntimeError('Cyclic dependency requires manual review.')
  order+=ready;pending.difference_update(ready)
 return counts,order

def finish_storage(args,backup):
 plan_path=backup/'reset-plan.json';plan=json.loads(plan_path.read_text())
 if plan.get('business')!=BUSINESS or not plan.get('database_committed'):raise RuntimeError('No committed reset cleanup plan.')
 if not rows(f"SELECT id FROM businesses WHERE id='{BUSINESS}' AND maintenance_mode"):raise RuntimeError('Maintenance must remain enabled during cleanup.')
 url=os.environ.get('SUPABASE_URL') or os.environ.get('VITE_SUPABASE_URL');key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
 if not url or not key:raise RuntimeError('Storage API configuration required; reset remains in maintenance.')
 existing={r['name'] for r in rows(f"SELECT name FROM storage.objects WHERE bucket_id='worktrack-evidence' AND name LIKE '{BUSINESS}/%'")}
 for start in range(0,len(plan['paths']),100):
  paths=[p for p in plan['paths'][start:start+100] if p in existing]
  if not paths:continue
  req=urllib.request.Request(url.rstrip('/')+'/storage/v1/object/worktrack-evidence',data=json.dumps({'prefixes':paths}).encode(),method='DELETE',headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=60) as response:response.read()
  except Exception:raise RuntimeError('Storage cleanup incomplete; database reset committed, maintenance retained. Resume using the protected reset plan; do not re-run reset.')
 remaining=rows(f"SELECT name FROM storage.objects WHERE bucket_id='worktrack-evidence' AND name LIKE '{BUSINESS}/%'")
 if remaining:raise RuntimeError('Storage objects remain; cleanup incomplete. Maintenance retained.')
 query(f"UPDATE businesses SET maintenance_mode=false WHERE id='{BUSINESS}';")
 plan['storage_complete']=True;plan_path.write_text(json.dumps(plan,indent=2))
 print('Reset and storage cleanup complete. Existing business/Auth preserved. Obsolete offline epochs rejected.')

def reset(args):
 counts,order=reset_plan();print('Vuyo Contracting only; dry-run unless explicit execution.');print(json.dumps(counts,indent=2));print('Deletion order:',', '.join(order))
 print('Preserve business/settings, Auth, memberships, roles/pay rules, preferences, accounts chart, audit and migration history.')
 if not args.execute:return
 if args.confirm!='RESET VUYO CONTRACTING' or not args.allow_test_history or args.maintenance_confirm!='ALL DEVICES STOPPED':raise RuntimeError('Typed reset/history/device-stop confirmations required.')
 backup=verify_backup(args.backup)
 if (backup/'reset-plan.json').exists():raise RuntimeError('This backup already has a reset plan. Resume incomplete storage cleanup or use a new verified backup; do not duplicate reset.')
 if not os.environ.get('SUPABASE_SERVICE_ROLE_KEY'):raise RuntimeError('Storage API configuration required before reset.')
 query(f"UPDATE businesses SET maintenance_mode=true WHERE id='{BUSINESS}';")
 counts,order=reset_plan() # recompute after writes are blocked, not from stale dry-run
 paths=[r['name'] for r in rows(f"SELECT name FROM storage.objects WHERE bucket_id='worktrack-evidence' AND name LIKE '{BUSINESS}/%'")]
 plan={'business':BUSINESS,'paths':paths,'database_committed':False,'storage_complete':False};plan_path=backup/'reset-plan.json';plan_path.write_text(json.dumps(plan,indent=2));plan_path.chmod(0o600)
 stmts=['BEGIN;',f"SELECT pg_advisory_xact_lock(hashtextextended('{BUSINESS}',0));",f"UPDATE memberships SET assigned_job_ids='{{}}' WHERE business_id='{BUSINESS}';",f"UPDATE invitations SET assigned_job_ids='{{}}' WHERE business_id='{BUSINESS}';"]
 for t in order:stmts.append(f'DELETE FROM public."{t}" WHERE business_id=\'{BUSINESS}\';')
 stmts += [f"UPDATE accounts SET opening_balance_cents=0,opening_balance_verified=true WHERE business_id='{BUSINESS}';",f"UPDATE businesses SET data_epoch=data_epoch+1 WHERE id='{BUSINESS}';",f"INSERT INTO audit_events(business_id,actor_user_id,entity_type,entity_id,action,reason) VALUES('{BUSINESS}',{sql_literal(args.actor)}::uuid,'business','{BUSINESS}','administrative_reset','Verified-backup clean start; Storage cleanup pending');",'COMMIT;']
 query('\n'.join(stmts));plan['database_committed']=True;plan_path.write_text(json.dumps(plan,indent=2));finish_storage(args,backup)

def resume(args):
 if not args.execute or args.confirm!='FINISH VUYO STORAGE CLEANUP':raise RuntimeError('Resume needs explicit --execute --confirm "FINISH VUYO STORAGE CLEANUP".')
 finish_storage(args,verify_backup(args.backup))

def import_workers(args):
 date=datetime.date.fromisoformat(args.effective_from)
 print('Verified list: 13 active workers, 11 road workers at 25000 cents/day, cook at 50000 cents/week, supervisor rate absent. No attendance or jobs.')
 print(json.dumps(WORKERS,indent=2))
 if not args.execute: return
 if args.confirm!='IMPORT VERIFIED 13 WORKERS': raise RuntimeError('Explicit worker import confirmation required.')
 verify_backup(args.backup)
 assert_clean_start(False)
 if int(query(f"SELECT count(*) FROM workers WHERE business_id='{BUSINESS}' AND import_key IS NULL")):
  raise RuntimeError('Unmapped workers exist. Run/reset and review first; no fuzzy name matching or duplicate identities are created.')
 statements=['BEGIN;',f"SELECT pg_advisory_xact_lock(hashtextextended('{BUSINESS}',0));"]
 for typ,name,crew in [('supervisor','Supervisor',False),('road_worker','Road worker',True),('cook','Cook',False)]:
  rid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-role:'+typ))
  statements.append(f"INSERT INTO worker_roles(id,business_id,role_type,name,shares_crew_schedule,active) VALUES('{rid}','{BUSINESS}',{sql_literal(typ)},{sql_literal(name)},{str(crew).lower()},true) ON CONFLICT(id) DO NOTHING;")
  if typ=='supervisor': continue
  rate=25000 if typ=='road_worker' else 50000; basis='daily' if typ=='road_worker' else 'weekly'; policy='none' if typ=='road_worker' else args.cook_policy
  rateid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-rate:'+typ+':'+str(date)))
  statements.append(f"INSERT INTO pay_rules(id,business_id,worker_role_id,pay_basis,base_rate_cents,normal_hours_per_day,normal_workdays_per_week,weekly_proration_policy,effective_from,is_confirmed,notes,created_by) VALUES('{rateid}','{BUSINESS}','{rid}','{basis}',{rate},{args.normal_hours},{args.workdays},'{policy}','{date}',true,'Verified standard rate; normal hours/calendar and overtime require management legal confirmation before payroll',{sql_literal(args.actor)}::uuid) ON CONFLICT(id) DO NOTHING;")
 for key,name,typ in WORKERS:
  wid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-worker:'+key));rid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-role:'+typ))
  statements.append(f"INSERT INTO workers(id,business_id,full_name,worker_role_id,employment_start_date,active,opening_balance_cents,opening_balance_verified,import_key,created_by) VALUES('{wid}','{BUSINESS}',{sql_literal(name)},'{rid}','{date}',true,0,true,{sql_literal('verified-2026:'+key)},{sql_literal(args.actor)}::uuid) ON CONFLICT(business_id,import_key) WHERE import_key IS NOT NULL DO NOTHING;")
 for typ in ['road_worker','cook']:
  rid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-role:'+typ));expected=25000 if typ=='road_worker' else 50000;basis='daily' if typ=='road_worker' else 'weekly';policy='none' if typ=='road_worker' else args.cook_policy
  statements.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pay_rules WHERE business_id='{BUSINESS}' AND worker_role_id='{rid}' AND base_rate_cents={expected} AND pay_basis='{basis}' AND normal_hours_per_day={args.normal_hours} AND normal_workdays_per_week={args.workdays} AND weekly_proration_policy='{policy}' AND effective_from='{date}' AND effective_to IS NULL AND is_confirmed) OR (SELECT count(*) FROM pay_rules WHERE business_id='{BUSINESS}' AND worker_role_id='{rid}')<>1 THEN RAISE EXCEPTION 'Import pay terms conflict; use rate maintenance, not re-import'; END IF; END $$;")
 for key,name,typ in WORKERS:
  wid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-worker:'+key));rid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-role:'+typ))
  statements.append(f"DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM workers WHERE id='{wid}' AND business_id='{BUSINESS}' AND full_name={sql_literal(name)} AND worker_role_id='{rid}' AND employment_start_date='{date}' AND active AND opening_balance_cents=0 AND opening_balance_verified) THEN RAISE EXCEPTION 'Existing import identity differs; no overwrite'; END IF; END $$;")
 statements += [f"INSERT INTO audit_events(business_id,actor_user_id,entity_type,entity_id,action,reason) VALUES('{BUSINESS}',{sql_literal(args.actor)}::uuid,'worker_import','{BUSINESS}','verified_register_import','13 verified workers; no opening financial transactions');",'COMMIT;']
 query('\n'.join(statements)); verify(args)
def assert_clean_start(require_workers=True):
 available=set(tenant_tables())
 for table in sorted(RESET_TABLES-{'workers'}):
  if table in available and int(query(f'SELECT count(*) FROM public."{table}" WHERE business_id=\'{BUSINESS}\';')):raise RuntimeError('Clean start has operational/financial history: '+table)
 if int(query(f"SELECT count(*) FROM accounts WHERE business_id='{BUSINESS}' AND opening_balance_cents<>0")):raise RuntimeError('Account opening balances must be zero.')
 if int(query(f"SELECT count(*) FROM workers WHERE business_id='{BUSINESS}' AND opening_balance_cents<>0")):raise RuntimeError('Worker opening balances must be zero.')
 if require_workers:
  if int(query(f"SELECT count(*) FROM workers WHERE business_id='{BUSINESS}'"))!=13:raise RuntimeError('Exactly 13 worker records required.')
  distribution=rows(f"SELECT r.role_type,count(*)::int n FROM workers w JOIN worker_roles r ON r.id=w.worker_role_id WHERE w.business_id='{BUSINESS}' AND w.active GROUP BY r.role_type")
  if {r['role_type']:r['n'] for r in distribution}!={'road_worker':11,'supervisor':1,'cook':1}:raise RuntimeError('Expected exactly 11 road workers, 1 Supervisor and 1 Cook.')
  for key,name,typ in WORKERS:
   if not rows(f"SELECT 1 FROM workers w JOIN worker_roles r ON r.id=w.worker_role_id WHERE w.business_id='{BUSINESS}' AND w.import_key={sql_literal('verified-2026:'+key)} AND w.full_name={sql_literal(name)} AND r.role_type={sql_literal(typ)} AND w.active"):raise RuntimeError('Verified worker identity missing or changed.')
  rid=str(uuid.uuid5(uuid.UUID(BUSINESS),'verified-role:supervisor'))
  if int(query(f"SELECT count(*) FROM pay_rules WHERE business_id='{BUSINESS}' AND worker_role_id='{rid}'")):raise RuntimeError('Andile Supervisor pay must remain unconfirmed; no invented rate.')

def verify(args):
 if args.require_clean:assert_clean_start()
 print(json.dumps(rows(f"SELECT r.role_type,count(*)::int active_workers FROM workers w JOIN worker_roles r ON r.id=w.worker_role_id WHERE w.business_id='{BUSINESS}' AND w.active GROUP BY r.role_type"),indent=2))
 print('Verification completed; clean-start assertions applied.' if args.require_clean else 'Read-only roster inspection. Use --require-clean for zero-history assertions.')

def main():
 p=argparse.ArgumentParser();p.add_argument('operation',choices=['reset','import','verify','resume']);p.add_argument('--actor',required=True,type=lambda x:str(uuid.UUID(x)));p.add_argument('--execute',action='store_true');p.add_argument('--dry-run',action='store_true');p.add_argument('--confirm',default='');p.add_argument('--allow-test-history',action='store_true');p.add_argument('--backup',default='');p.add_argument('--effective-from');p.add_argument('--require-clean',action='store_true');p.add_argument('--maintenance-confirm',default='');p.add_argument('--normal-hours',type=float);p.add_argument('--workdays',type=int);p.add_argument('--cook-policy',choices=['full_week_entitlement','prorated_by_days']);args=p.parse_args()
 if args.execute and args.dry_run: p.error('Choose dry-run or execute, not both.')
 if args.operation=='import' and (not args.effective_from or args.normal_hours is None or args.workdays is None or not args.cook_policy): p.error('Import requires confirmed --effective-from YYYY-MM-DD, --normal-hours, --workdays and --cook-policy. No legal pay terms are invented.')
 if args.operation=='import' and not (0<args.normal_hours<=24 and 1<=args.workdays<=7): p.error('Invalid normal hours or workdays.')
 if 'DATABASE_URL' not in os.environ: p.error('Set DATABASE_URL securely in deploy/.env.')
 verify_admin(args.actor)
 {'reset':reset,'import':import_workers,'verify':verify,'resume':resume}[args.operation](args)
if __name__=='__main__':
 try: main()
 except Exception as exc: print('STOP:',str(exc),file=sys.stderr);sys.exit(1)
