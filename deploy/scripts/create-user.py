#!/usr/bin/env python3
import argparse,getpass,json,os,subprocess,sys,urllib.request,urllib.error,uuid

def sql(s):
 env=os.environ.copy();env['PGDATABASE']=env['DATABASE_URL']
 r=subprocess.run(['psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True,env=env)
 if r.returncode: raise RuntimeError('Database change failed; inspect securely on VM.')
 return r.stdout.strip()
def lit(s):return "'"+s.replace("'","''")+"'"
def auth(method,path,payload=None):
 key=os.environ['SUPABASE_SERVICE_ROLE_KEY'];url=os.environ.get('SUPABASE_URL') or os.environ['VITE_SUPABASE_URL']
 req=urllib.request.Request(url.rstrip('/')+'/auth/v1/'+path,data=json.dumps(payload).encode() if payload is not None else None,method=method,headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30) as response:return json.loads(response.read() or '{}')
 except urllib.error.HTTPError as e: raise RuntimeError('Auth operation refused (HTTP '+str(e.code)+'); no credentials or response body logged.')
def main():
 p=argparse.ArgumentParser();p.add_argument('--email',required=True);p.add_argument('--name',required=True);p.add_argument('--role',choices=['admin','owner','supervisor'],required=True);g=p.add_mutually_exclusive_group(required=True);g.add_argument('--business-id');g.add_argument('--business-name');p.add_argument('--recover-password',action='store_true');a=p.parse_args()
 if '@' not in a.email or not a.name.strip():p.error('Valid email/name required.')
 for v in ['DATABASE_URL','SUPABASE_SERVICE_ROLE_KEY']:
  if not os.environ.get(v):p.error('Required server-side configuration missing: '+v)
 if not(os.environ.get('SUPABASE_URL') or os.environ.get('VITE_SUPABASE_URL')):p.error('Auth URL missing.')
 if a.business_id:
  bid=str(uuid.UUID(a.business_id))
  if sql(f"SELECT id FROM businesses WHERE id='{bid}'")!=bid:raise RuntimeError('Business does not exist. Auth user was not created.')
 else:
  # stdin SQL supports safe psql variable substitution; no -c substitution.
  matches=sql(f'SELECT id FROM businesses WHERE name={lit(a.business_name)} ORDER BY id;').splitlines()
  if len(matches)>1:raise RuntimeError('Multiple businesses with this name; provide explicit --business-id.')
  bid=matches[0] if matches else sql(f"BEGIN; SELECT pg_advisory_xact_lock(hashtextextended({lit(a.business_name)},9)); INSERT INTO businesses(name) SELECT {lit(a.business_name)} WHERE NOT EXISTS(SELECT 1 FROM businesses WHERE name={lit(a.business_name)}); SELECT id FROM businesses WHERE name={lit(a.business_name)}; COMMIT;").splitlines()[-1]
 existing=sql(f"SELECT u.id FROM auth.users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=lower({lit(a.email)}) AND m.business_id='{bid}';")
 if existing and not a.recover_password:
  print('Existing business account preserved; no duplicate user created. Use WorkTrack Settings to maintain access, or --recover-password explicitly.');return
 password=getpass.getpass('New temporary password (at least 12 characters): ')
 if len(password)<12 or len(password)>128:raise RuntimeError('Password must have 12–128 characters.')
 if password!=getpass.getpass('Confirm temporary password: '):raise RuntimeError('Passwords do not match.')
 if a.recover_password:
  if not existing:raise RuntimeError('Recovery requires existing membership in this business.')
  auth('PUT','admin/users/'+existing,{'password':password});print('Password recovered. Share securely; user should change it on sign-in.');return
 created=auth('POST','admin/users',{'email':a.email,'password':password,'email_confirm':True,'user_metadata':{'full_name':a.name}});uid=str(uuid.UUID(created['id']));password=''
 try:
  sql(f"BEGIN; INSERT INTO profiles(id,email,full_name) VALUES('{uid}',{lit(a.email)},{lit(a.name)}) ON CONFLICT(id) DO NOTHING; INSERT INTO memberships(business_id,user_id,email,full_name,role,active) VALUES('{bid}','{uid}',{lit(a.email)},{lit(a.name)},{lit(a.role)}::public.app_role,true); COMMIT;")
 except Exception:
  try:auth('DELETE','admin/users/'+uid)
  except Exception:raise RuntimeError('Membership failed and NEW account cleanup failed. Existing business/accounts were not changed; review on VM.')
  raise RuntimeError('Membership failed; newly created account removed. Existing accounts preserved.')
 print('Account and membership created. Share temporary password securely and change it in WorkTrack Settings.')
if __name__=='__main__':
 try:main()
 except Exception as e:print('STOP:',str(e),file=sys.stderr);sys.exit(1)
