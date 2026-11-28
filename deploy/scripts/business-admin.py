#!/usr/bin/env python3
"""Explicit VM-only reset/import; no credentials in process arguments or logs."""
import argparse, datetime, hashlib, json, os, pathlib, subprocess, sys, urllib.request, uuid
BUSINESS='d7afd88f-4a5e-4dcd-8af9-c58e835f561e'
ROAD=['Mabhuti','Siyabulela','Simamkele','Luzuko','Luthando','Athenkosi','Akhona','Zukhanye','Nandipha','Xolani','Malibongwe']
WORKERS=[('andile','Andile','supervisor')]+[(name.lower(),name,'road_worker') for name in ROAD]+[('cook','Cook - name to be confirmed','cook')]
PRESERVE={'businesses','memberships','profiles','invitations','audit_events','worker_roles','pay_rules','notification_preferences','admin_operation_log','accounts'}
RESET_TABLES={'assessment_route_points','assessment_revisions','assessments','benchmarks','jobs','workers','worker_assignments','rate_override_requests','progress_entries','interruptions','team_days','attendance_entries','payroll_runs','payroll_run_lines','payroll_adjustments','journal_entries','journal_lines','wage_payments','wage_allocations','expenses','expense_requests','transfers','reconciliations','payment_milestones','customer_receipts','expense_settlements','forecast_assumptions','loans','loan_events','assets','asset_private','asset_checks','defects','asset_services','weekly_reports','notifications','notification_receipts','evidence_attachments','sync_idempotency_keys'}
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
 for name,digest in m['files'].items():
  if hashlib.sha256((p/name).read_bytes()).hexdigest()!=digest: raise RuntimeError('Backup checksum mismatch: '+name)
 if not all(k in m['files'] for k in ['database.dump','storage.tar.gz','configuration.tar.gz']): raise RuntimeError('Backup must include database, storage and configuration.')
 if m.get('database_fingerprint')!=query("SELECT md5(current_database()||':'||(SELECT system_identifier::text FROM pg_control_system()))"):
  raise RuntimeError('Backup was made against a different database.')
 return p

def tenant_tables():
 return [r['table_name'] for r in rows("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='business_id' ORDER BY table_name") if r['table_name'] in RESET_TABLES and r['table_name'] not in PRESERVE]
def reset(args):
 tables=tenant_tables(); counts={t:int(query(f'SELECT count(*) FROM public."{t}" WHERE business_id=\'{BUSINESS}\';')) for t in tables}
 print('Target: existing Vuyo Contracting only. Dry run' if not args.execute else 'Target: existing Vuyo Contracting only. EXECUTION REQUESTED')
 print(json.dumps(counts,indent=2))
 print('Preserved: Auth accounts, memberships, business/settings, roles/pay rules, notification preferences, audit history and schema/migration history.')
 approved=rows(f"SELECT 'payroll' kind,count(*) count FROM public.payroll_runs WHERE business_id='{BUSINESS}' AND status='approved' UNION ALL SELECT 'reports',count(*) FROM public.weekly_reports WHERE business_id='{BUSINESS}' AND status='approved' UNION ALL SELECT 'journals',count(*) FROM public.journal_entries WHERE business_id='{BUSINESS}'")
 print('Historical/approved records requiring review:',json.dumps(approved))
 # Build actual FK graph and refuse dependencies from preserved/outside tables.
 edges=rows("SELECT child.relname child,parent.relname parent,ns.nspname child_schema,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace JOIN pg_class parent ON parent.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace WHERE c.contype='f' AND pn.nspname='public'")
 for e in edges:
  if e['parent'] in tables and (e['child'] not in tables or e['child_schema']!='public'):
   if e['child']=='assets' and e['parent']=='jobs': continue
   raise RuntimeError('Unexpected preserved/external dependency: '+str(e))
 # Self references are cleared explicitly inside the same transaction.
 order=[]; pending=set(tables)
 while pending:
  ready=sorted(t for t in pending if not any(e['parent']==t and e['child'] in pending and e['child']!=t for e in edges))
  if not ready: raise RuntimeError('Cyclic dependencies require manual review: '+str(sorted(pending)))
  order.extend(ready); pending.difference_update(ready)
 print('Deletion order:',', '.join(order))
 evidence=rows(f"SELECT storage_path FROM public.evidence_attachments WHERE business_id='{BUSINESS}'")
 if not args.execute: return
 if args.confirm != 'RESET VUYO CONTRACTING' or not args.allow_test_history: raise RuntimeError('Execution requires --confirm "RESET VUYO CONTRACTING" and --allow-test-history after reviewing dry-run.')
 backup=verify_backup(args.backup)
 if args.maintenance_confirm!='ALL DEVICES STOPPED': raise RuntimeError('Stop application/write traffic and confirm --maintenance-confirm "ALL DEVICES STOPPED".')
 query(f"UPDATE public.businesses SET maintenance_mode=true WHERE id='{BUSINESS}';")
 # Storage is a separate service: remove objects first while write traffic is stopped.
 # If any cleanup fails, retain DB metadata and report incomplete cleanup; backup
 # contains the original files for recovery. Never delete storage.objects by SQL.
 url=os.environ.get('SUPABASE_URL') or os.environ.get('VITE_SUPABASE_URL'); key=os.environ.get('SUPABASE_SERVICE_ROLE_KEY')
 if not url or not key: raise RuntimeError('Storage API configuration required.')
 for start in range(0,len(evidence),100):
  paths=[x['storage_path'] for x in evidence[start:start+100]]
  req=urllib.request.Request(url.rstrip('/')+'/storage/v1/object/worktrack-evidence',data=json.dumps({'prefixes':paths}).encode(),method='DELETE',headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=60) as response: response.read()
  except Exception: raise RuntimeError('Storage deletion failed. Database retained; stop and restore evidence from the verified backup before retrying.')
 stmts=['BEGIN;',f"SELECT pg_advisory_xact_lock(hashtextextended('{BUSINESS}',0));",f"UPDATE public.memberships SET assigned_job_ids='{{}}' WHERE business_id='{BUSINESS}';",f"UPDATE public.invitations SET assigned_job_ids='{{}}' WHERE business_id='{BUSINESS}';"]
 # Do not bypass financial immutability triggers as a normal user. This procedure
 # uses VM database-owner credentials, null auth identity, and explicit scope.
 for t in order: stmts.append(f'DELETE FROM public."{t}" WHERE business_id=\'{BUSINESS}\';')
 stmts.extend([f"UPDATE public.accounts SET opening_balance_cents=0 WHERE business_id='{BUSINESS}';",f"UPDATE public.businesses SET data_epoch=data_epoch+1,maintenance_mode=false WHERE id='{BUSINESS}';",f"INSERT INTO public.audit_events(business_id,actor_user_id,entity_type,entity_id,action,reason,changed_fields) VALUES('{BUSINESS}',{sql_literal(args.actor)}::uuid,'business','{BUSINESS}','administrative_reset','Next contract clean start',jsonb_build_object('counts',{sql_literal(json.dumps(counts))}::jsonb,'backup',{sql_literal(str(backup))}));",'COMMIT;'])
 query('\n'.join(stmts))
 print('Reset committed. Only this business was cleared. Old offline epochs are rejected; each device must discard obsolete queued data.')
 print('Storage removed:',len(evidence),'metadata-linked objects. Unlinked Storage objects require the orphan audit described in the runbook.')
def import_workers(args):
 date=datetime.date.fromisoformat(args.effective_from)
 print('Verified list: 13 active workers, 11 road workers at 25000 cents/day, cook at 50000 cents/week, supervisor rate absent. No attendance or jobs.')
 print(json.dumps(WORKERS,indent=2))
 if not args.execute: return
 if args.confirm!='IMPORT VERIFIED 13 WORKERS': raise RuntimeError('Explicit worker import confirmation required.')
 verify_backup(args.backup)
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
 statements += [f"INSERT INTO audit_events(business_id,actor_user_id,entity_type,entity_id,action,reason) VALUES('{BUSINESS}',{sql_literal(args.actor)}::uuid,'worker_import','{BUSINESS}','verified_register_import','13 verified workers; no opening financial transactions');",'COMMIT;']
 query('\n'.join(statements)); verify(args)
def verify(args):
 print(json.dumps(rows(f"SELECT role_type,count(*)::int active_workers FROM workers w JOIN worker_roles r ON r.id=w.worker_role_id AND r.business_id=w.business_id WHERE w.business_id='{BUSINESS}' AND w.active GROUP BY role_type ORDER BY role_type"),indent=2))
 result=rows(f"SELECT (SELECT count(*) FROM workers WHERE business_id='{BUSINESS}' AND active) workers,(SELECT count(*) FROM jobs WHERE business_id='{BUSINESS}') jobs,(SELECT count(*) FROM payroll_runs WHERE business_id='{BUSINESS}') payroll,(SELECT count(*) FROM expenses WHERE business_id='{BUSINESS}') expenses,(SELECT count(*) FROM journal_entries WHERE business_id='{BUSINESS}') journals,(SELECT count(*) FROM loans WHERE business_id='{BUSINESS}') loans,(SELECT count(*) FROM wage_payments WHERE business_id='{BUSINESS}') payments,(SELECT coalesce(sum(opening_balance_cents),0) FROM workers WHERE business_id='{BUSINESS}') worker_balances")
 print(json.dumps(result,indent=2))
 if args.require_clean:
  r=result[0]
  if r['workers']!=13 or any(r[k]!=0 for k in r if k!='workers'): raise RuntimeError('Clean-start verification failed; review counts above.')

def main():
 p=argparse.ArgumentParser();p.add_argument('operation',choices=['reset','import','verify']);p.add_argument('--actor',required=True,type=lambda x:str(uuid.UUID(x)));p.add_argument('--execute',action='store_true');p.add_argument('--dry-run',action='store_true');p.add_argument('--confirm',default='');p.add_argument('--allow-test-history',action='store_true');p.add_argument('--backup',default='');p.add_argument('--effective-from');p.add_argument('--require-clean',action='store_true');p.add_argument('--maintenance-confirm',default='');p.add_argument('--normal-hours',type=float);p.add_argument('--workdays',type=int);p.add_argument('--cook-policy',choices=['full_week_entitlement','prorated_by_days']);args=p.parse_args()
 if args.execute and args.dry_run: p.error('Choose dry-run or execute, not both.')
 if args.operation=='import' and (not args.effective_from or args.normal_hours is None or args.workdays is None or not args.cook_policy): p.error('Import requires confirmed --effective-from YYYY-MM-DD, --normal-hours, --workdays and --cook-policy. No legal pay terms are invented.')
 if args.operation=='import' and not (0<args.normal_hours<=24 and 1<=args.workdays<=7): p.error('Invalid normal hours or workdays.')
 if 'DATABASE_URL' not in os.environ: p.error('Set DATABASE_URL securely in deploy/.env.')
 verify_admin(args.actor)
 {'reset':reset,'import':import_workers,'verify':verify}[args.operation](args)
if __name__=='__main__':
 try: main()
 except Exception as exc: print('STOP:',str(exc),file=sys.stderr);sys.exit(1)
