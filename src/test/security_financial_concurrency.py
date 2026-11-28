"""Local-only PostgreSQL security drill; never accepts a production connection.

Run after starting a disposable cluster under /tmp/worktrack-security-pg/data
with its Unix socket at /tmp/worktrack-security-pg/socket, port 54399 and
synthetic superuser security_test. Uses no environment database credentials.
"""
import os
from pathlib import Path
import re
import subprocess
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
SOCKET = "/tmp/worktrack-security-pg/socket"
BUSINESS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ADMIN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
LOAN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
ENV = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
DATABASE = "security_financial_drill_" + uuid.uuid4().hex[:12]


def command(database=DATABASE):
    return ["psql", "-X", "-h", SOCKET, "-p", "54399", "-U", "security_test",
            "-d", database, "-v", "ON_ERROR_STOP=1", "-At"]


def sql(text, database=DATABASE):
    result = subprocess.run(command(database), input=text, text=True,
                            capture_output=True, env=ENV, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def user_sql(user):
    return (f"SELECT set_config('request.jwt.claim.sub','{user}',false);"
            "SELECT set_config('request.headers','{\"x-worktrack-epoch\":\"1\"}',false);"
            "SET ROLE authenticated;")


class FinancialConcurrencyDrill(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = sql("SHOW data_directory;", "postgres")
        if path != "/tmp/worktrack-security-pg/data":
            raise RuntimeError("Refusing any database outside the disposable local cluster")
        sql(f"CREATE DATABASE {DATABASE};", "postgres")
        sql("""DO $$ BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
          END $$;
          CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
          CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
          CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text,name text,owner_id text,metadata jsonb);
          ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
          CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array($1,'/') $$;
          GRANT USAGE ON SCHEMA public,auth,storage TO authenticated,anon,service_role;
          GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;""")
        migrations = sorted((ROOT / "db/migrations").glob("*.sql"))
        for migration in migrations:
            sql("BEGIN;" + re.sub(r"CREATE EXTENSION[^;]*;", "", migration.read_text()) + "COMMIT;")
        cls.migration_count = len(migrations)
        sql(f"""INSERT INTO auth.users VALUES('{ADMIN}','admin@synthetic.invalid'),('{OWNER}','owner@synthetic.invalid');
          INSERT INTO businesses(id,name) VALUES('{BUSINESS}','Disposable concurrency fixture');
          INSERT INTO memberships(business_id,user_id,email,full_name,role) VALUES
          ('{BUSINESS}','{ADMIN}','admin@synthetic.invalid','Admin','admin'),('{BUSINESS}','{OWNER}','owner@synthetic.invalid','Owner','owner');""")
        sql(user_sql(ADMIN) + f"SELECT worktrack_setup_accounts('{BUSINESS}');")
        cls.bank = sql(f"SELECT id FROM accounts WHERE business_id='{BUSINESS}' AND account_type='bank';")
        cls.liability = sql(f"SELECT id FROM accounts WHERE business_id='{BUSINESS}' AND account_type='loan_liability';")
        equity = sql(f"SELECT id FROM accounts WHERE business_id='{BUSINESS}' AND account_type='owner_equity';")
        opening = str(uuid.uuid4())
        sql(user_sql(ADMIN) + f"""BEGIN;
          INSERT INTO loans(id,business_id,lender_name,opening_principal_cents,opening_principal_verified) VALUES('{LOAN}','{BUSINESS}','Synthetic lender',10000,true);
          INSERT INTO journal_entries(id,business_id,entry_date,source_type,source_id,evidence_status) VALUES('{opening}','{BUSINESS}','2026-12-01','loan_opening','{LOAN}','verified');
          INSERT INTO journal_lines(business_id,journal_entry_id,account_id,debit_cents,credit_cents) VALUES
          ('{BUSINESS}','{opening}','{equity}',10000,0),('{BUSINESS}','{opening}','{cls.liability}',0,10000); COMMIT;""")

    def test_two_direct_repayments_serialize_and_cannot_overpay(self):
        self.assertEqual(self.migration_count, 24)
        def repayment(name, hold):
            event, journal = str(uuid.uuid4()), str(uuid.uuid4())
            return user_sql(OWNER) + f"""SET application_name='{name}'; BEGIN;
              INSERT INTO journal_entries(id,business_id,entry_date,source_type,source_id,evidence_status) VALUES('{journal}','{BUSINESS}','2026-12-02','loan_repayment','{event}','reported');
              INSERT INTO journal_lines(business_id,journal_entry_id,account_id,debit_cents,credit_cents) VALUES
              ('{BUSINESS}','{journal}','{self.liability}',7000,0),('{BUSINESS}','{journal}','{self.bank}',0,7000);
              INSERT INTO loan_events(id,business_id,loan_id,event_date,event_type,amount_cents,account_id,evidence_status,journal_entry_id) VALUES
              ('{event}','{BUSINESS}','{LOAN}','2026-12-02','repayment',7000,'{self.bank}','reported','{journal}');
              SELECT pg_sleep({hold}); COMMIT;"""
        first = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, env=ENV)
        if first.stdin is None:
            raise RuntimeError("Missing test subprocess input")
        first.stdin.write(repayment("worktrack_drill_first", 3))
        first.stdin.close()
        deadline = time.monotonic() + 5
        while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='worktrack_drill_first' AND wait_event='PgSleep';") != "1":
            if time.monotonic() > deadline:
                first.kill()
                self.fail("First test transaction did not reach the deliberate hold")
            time.sleep(0.03)
        second = subprocess.Popen(command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, env=ENV)
        if second.stdin is None:
            raise RuntimeError("Missing second test subprocess input")
        second.stdin.write(repayment("worktrack_drill_second", 0))
        second.stdin.close()
        blocked = False
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='worktrack_drill_second' AND wait_event_type='Lock' AND lower(wait_event)='advisory';") == "1":
                blocked = True
                break
            time.sleep(0.03)
        self.assertTrue(blocked, "Second direct financial writer must wait on the business lock")
        first.wait(timeout=10)
        second.wait(timeout=10)
        first_error = first.stderr.read() if first.stderr else ""
        second_error = second.stderr.read() if second.stderr else ""
        for process in (first, second):
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
        self.assertEqual(first.returncode, 0, first_error)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("Repayment exceeds remaining loan principal", second_error)
        self.assertEqual(sql(f"SELECT count(*)||':'||sum(amount_cents) FROM loan_events WHERE loan_id='{LOAN}';"), "1:7000")
        self.assertEqual(sql(f"SELECT count(*) FROM journal_entries WHERE business_id='{BUSINESS}';"), "2")


if __name__ == "__main__":
    unittest.main(verbosity=2)