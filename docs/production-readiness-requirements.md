# WorkTrack — Complete production readiness, resolve deployment defects and prepare for live business operations

## 1. Current deployment status

WorkTrack has now been successfully deployed to my own Hostinger Linux VM using Docker, self-hosted Supabase, PostgreSQL 17.6 and Nginx Proxy Manager.

The following infrastructure is operational:

- Application: https://worktrack.clickcraft.tech
- Supabase API: https://worktrack-api.clickcraft.tech
- Application container: worktrack-web.
- Application host port: 3080, restricted to localhost.
- Supabase API gateway: Envoy.
- Supabase API host port: 8400, restricted to localhost.
- PostgreSQL: accessible internally through Supavisor.
- Reverse proxy Docker network: npm-proxy.
- HTTPS certificates are operational.
- Public user registration is disabled.
- All eight database migrations have been successfully applied following manual corrections.

Two user accounts have been successfully created and tested:

- Mark Pattison — Management / Admin.
- Vuyo test — Owner.

Both accounts are linked to the same business, Vuyo Contracting.

The business ID is:

`d7afd88f-4a5e-4dcd-8af9-c58e835f561e`

Both accounts can successfully authenticate and access the application.

**Do not recreate the business, overwrite existing authentication accounts, reset the entire Supabase database or introduce a dependency on Lovable Cloud.**

Review the entire existing codebase, original specification, roadmap, deployment documentation and implemented functionality before making the following changes.

The objective is to complete the application and prepare it for actual business use, rather than simply demonstrate the functionality.

## 2. Complete all outstanding application functionality

The application documentation identified several areas where functionality was incomplete or still dependent on browser-local storage.

Complete all outstanding functionality across Increments A–F.

Do not merely mark the increments as complete or update the documentation to suggest that they are complete. Implement and test the underlying functionality.

### 2.1 Increment D — Finance and ledger

Replace all browser-local persistence for financial records with Supabase database persistence.

This includes:

- Wage payments.
- Wage payment allocations.
- Outstanding wages.
- Operating expenditure.
- Capital expenditure.
- Customer receipts.
- Customer invoices and receivables.
- Cash balances.
- Restricted and unrestricted funds.
- Loans.
- Loan drawdowns.
- Loan repayments.
- Financial ledger entries.
- Cash flow forecasts.
- Outstanding liabilities.
- Payment history.
- Financial reconciliations.

All financial data must be shared between authorised users and devices.

Ensure that financial transactions are not double-counted and that balances are derived from the relevant database transactions rather than independently maintained browser values.

Preserve the distinction between:

- Wages earned.
- Wages paid.
- Wages outstanding.
- Expenditure incurred.
- Expenditure paid.
- Loans received.
- Loan repayments.
- Customer income.
- Cash available.

All monetary amounts must continue to use integer ZAR cents in the database.

Support partial payments and payment allocations, including payments to individual workers.

Financial balances must reconcile to the underlying transactions and be traceable to the relevant business and job.

### 2.2 Increment E — Reports, vehicles and notifications

Replace all localStorage-based persistence for:

- Weekly reports.
- Weekly report revisions.
- Report submission, approval and amendments.
- Vehicle and equipment registers.
- Vehicle pre-use safety checks.
- Critical and non-critical defects.
- Vehicle maintenance.
- Fuel and servicing records.
- Notifications.
- Notification preferences.
- Acknowledgements and read status.

Ensure that approved report snapshots cannot be silently modified.

Ensure that critical vehicle defects trigger the stop-use process and are visible to authorised management users.

Where a vehicle has a critical unresolved defect, prevent it from being presented as available for normal operations until the appropriate resolution process has been completed.

### 2.3 Increment F — Offline synchronisation and evidence

Complete the offline functionality using IndexedDB or an appropriate durable local queue.

The browser may temporarily hold offline transactions, but it must not become the authoritative source of business data.

Implement:

- Reliable offline transaction capture.
- Automatic synchronisation when connectivity returns.
- Server-side idempotency checks.
- Duplicate transaction prevention.
- Visible synchronisation status.
- Failed synchronisation reporting and retry.
- Conflict detection and appropriate resolution.
- Persistence of offline records across application restarts.
- User and business isolation for locally cached data.
- Safe handling of logout when unsynchronised transactions exist.
- Protection against obsolete offline records being restored after an authorised business data reset.

Complete photograph and receipt functionality.

Uploading a file to Supabase Storage must also create the corresponding evidence_attachments metadata record, including the linked entity, business ID, uploader, file type, size, checksum and storage path.

Ensure that unsuccessful metadata creation does not leave uncontrolled orphan files in storage.

Evidence must remain private and accessible only through appropriate authenticated access or short-lived signed URLs.

Retain the existing 10 MB evidence file limit and approved MIME types.

Test GPS capture, intermediate route waypoints, camera access and offline operation on Android mobile devices.

## 3. Remove demonstration and hardcoded data

Both the Admin and Owner dashboards currently display an estimated cash shortfall of R171,000 even though no actual business financial transactions have been entered.

The planned-versus-actual graph also shows planned progress over four weeks despite no jobs having been created.

Investigate and remove any demonstration data, hardcoded financial assumptions, mock dashboard values, default forecasts and synthetic operational records from production mode.

Specifically:

- An empty business must display an appropriate empty state.
- No wage costs should be forecast unless supported by actual job plans and explicitly defined forecast inputs.
- No cash shortfall should appear without supporting financial assumptions.
- No planned job progress should appear unless a job and its plan exist.
- No demonstration workers, jobs, vehicles, expenses or financial transactions should automatically populate the business.
- No demonstration records should be introduced through browser-local fallback logic.
- The existence of workers in the worker register must not automatically generate wage liabilities, expenses or cash flow forecasts.

Estimated forecasts may be retained as functionality, but all assumptions must be visible, editable and clearly distinguished from actual business transactions.

Where Supabase is unavailable, show an appropriate offline or connection error state rather than silently switching to a synthetic demonstration environment.

Ensure that the "Connected to Supabase" and "All synced" indicators reflect actual connection and synchronisation status.

Development and demonstration modes must be explicitly separated from production mode.

## 4. Correct defects encountered during Linux deployment

The following defects were encountered during the actual deployment. Manual corrections have already been applied on the VM.

These corrections must now be incorporated into the authoritative GitHub source code.

### 4.1 Database migration E — Missing security function

File:

`db/migrations/202611270006_increment_e_reports_vehicles_notifications.sql`

The migration referenced the following function eight times:

```sql
public.is_business_member(business_id)
```

This function did not exist in the database.

All eight references were replaced with:

```sql
public.has_business_role(
  business_id,
  ARRAY['admin', 'owner', 'supervisor']::public.app_role[]
)
```

This reuses the existing security-definer function, which verifies active membership of the relevant business.

Incorporate this correction into the repository.

### 4.2 Database migration E — Incorrect PostgreSQL role array types

The same migration passed untyped text arrays into has_business_role(), which requires public.app_role[].

All applicable role arrays were explicitly cast, for example:

```sql
ARRAY['admin', 'owner']::public.app_role[]
```

and:

```sql
ARRAY['admin']::public.app_role[]
```

Eleven existing role array references were corrected.

Preserve these corrections.

Do not re-execute already successfully applied migrations against the existing database.

The corrected migration E must support new installations, but any additional schema or security changes required for the existing installation must be delivered through new, correctly numbered migrations.

### 4.3 Dockerfile — Dependency installation failure

The original Dockerfile contained:

```dockerfile
RUN npm install --no-audit --no-fund
```

The Linux Docker build failed with:

```text
npm error Cannot read properties of null (reading 'edgesOut')
```

The repository contains a bun.lock dependency lock file.

The following replacement resolved the issue:

```dockerfile
RUN npm install -g bun && bun install --frozen-lockfile
```

The application then compiled successfully and the production Docker image was created.

Incorporate this correction, preferably pinning Bun to a tested compatible version to ensure repeatable builds.

Ensure that any required Bun configuration files are available during dependency installation.

Retain Node.js 22 as the production runtime and retain the Nitro node-server deployment target.

### 4.4 Administrator account creation script

File:

`deploy/scripts/create-user.sh`

The original business creation SQL used psql variable substitution with the -c option, which did not support the required substitution.

The working replacement is:

```bash
BUSINESS_ID="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v bname="$BUSINESS_NAME" -qtA \
  <<< "INSERT INTO public.businesses (name) VALUES (:'bname') RETURNING id;")"
```

This correction has been successfully tested.

Also improve the script to:

- Handle partial account creation failures safely.
- Validate the business before creating an authentication user where appropriate.
- Support recovery without creating duplicate users or businesses.
- Validate all required parameters before making database or authentication changes.
- Avoid unnecessary exposure of passwords and privileged credentials through process arguments, logs or command output.

### 4.5 Migration script reliability

Improve deploy/scripts/migrate.sh so that:

- Migration files are applied in the correct order.
- Existing migration history is respected.
- Failed migrations do not leave unnecessary partially applied changes.
- Migrations are transactional where supported.
- Migration completion is recorded atomically with successful execution wherever possible.
- Concurrent migration execution is prevented.
- Errors clearly identify the failing migration.

Account for existing migration files that already contain explicit BEGIN and COMMIT statements.

Do not invalidate the existing migration history.

## 5. Reset business data and populate the worker register

Vuyo Contracting will use WorkTrack from the commencement of its next contract.

The previous contract has been completed, and no historical financial transactions or outstanding liabilities from that contract are to be carried forward into WorkTrack.

The next contract must start from a completely clean financial and operational position.

The only information to be carried forward is the worker register.

### 5.1 Clear existing business data

Provide a controlled, one-time administrative reset script that clears all existing demonstration, test and transactional data associated with Vuyo Contracting.

This includes:

- Jobs and assessments.
- Job plans and progress records.
- GPS route records and waypoints.
- Daily work records.
- Attendance and overtime records.
- Payroll calculations and payroll runs.
- Wage payments and payment allocations.
- Outstanding wages and historical wage liabilities.
- Expenses and accommodation costs.
- Loans, loan drawdowns and repayments.
- Customer invoices, receipts and receivables.
- Cash balances and financial ledger entries.
- Financial forecasts and assumptions.
- Weekly reports and report revisions.
- Test vehicle records and safety checks.
- Test equipment records.
- Notifications and acknowledgements.
- Test photographs, receipts and evidence attachments.
- Demonstration and placeholder workers.
- Obsolete offline synchronisation records and idempotency entries associated with the reset data.

Also implement a mechanism to invalidate obsolete browser-local data, cached records and offline queues across devices so that previously deleted test records cannot reappear or synchronise back into Supabase.

Preserve:

- The existing Vuyo Contracting business.
- Existing authentication accounts.
- Admin and Owner memberships and permissions.
- Application configuration.
- Business settings that are not demonstration data.
- Database schema and migration history.
- Security policies.
- Existing audit history where required for accountability.
- Audit records relating to the reset itself.

The reset must apply only to Vuyo Contracting, using its existing business ID:

`d7afd88f-4a5e-4dcd-8af9-c58e835f561e`

It must not affect other businesses, applications or Supabase system tables.

The reset procedure must:

- Provide a dry-run option.
- Display the number and type of records that will be affected.
- Identify genuine historical records and unexpected dependencies before deletion.
- Require explicit confirmation before executing.
- Create and verify a backup beforehand.
- Respect foreign-key relationships.
- Avoid uncontrolled cascading deletions.
- Coordinate database record deletion with private Storage object removal.
- Clearly report any unsuccessful or incomplete cleanup.
- Produce an audit record of the reset.

Do not perform this reset automatically during application startup, normal deployment or future application upgrades.

### 5.2 Populate the worker register

After clearing the existing worker register, populate it with the following workers.

| Worker name | Worker type | Standard pay |
|---|---|---:|
| Andile | Supervisor | To be confirmed |
| Mabhuti | Road worker | R250/day |
| Siyabulela | Road worker | R250/day |
| Simamkele | Road worker | R250/day |
| Luzuko | Road worker | R250/day |
| Luthando | Road worker | R250/day |
| Athenkosi | Road worker | R250/day |
| Akhona | Road worker | R250/day |
| Zukhanye | Road worker | R250/day |
| Nandipha | Road worker | R250/day |
| Xolani | Road worker | R250/day |
| Malibongwe | Road worker | R250/day |
| Cook - name to be confirmed | Cook | R500/week |

Expected worker register:

- Supervisors: 1.
- Road workers: 11.
- Cooks: 1.
- Total active workers: 13.

All workers should be active and available for assignment to the next job.

Do not automatically assign them to a job that has not yet been created.

Do not invent surnames, identity numbers, contact details, bank account information or other personal information.

The supervisor's pay rate must remain unconfirmed until management enters the correct rate. Do not silently substitute a zero wage rate or include an unconfirmed wage in payroll calculations.

The cook's name will be updated when confirmed.

The worker import must:

- Be explicitly executed by an administrator.
- Support a dry-run mode.
- Be repeatable without creating duplicate records.
- Use appropriate database transactions.
- Persist workers and their confirmed pay rules in Supabase.
- Preserve worker identities when their details are subsequently amended.
- Make all worker records visible to both authorised Admin and Owner users across different devices.

The worker names and roles will be verified against the original handwritten worker list before the actual import is executed.

### 5.3 Opening financial position

The application must start with the following financial position:

| Financial item | Opening balance |
|---|---:|
| Unrestricted cash | R0.00 |
| Restricted cash | R0.00 |
| Outstanding wages | R0.00 |
| Wages earned | R0.00 |
| Wages paid | R0.00 |
| Operating expenditure | R0.00 |
| Capital expenditure | R0.00 |
| Loan balances | R0.00 |
| Customer receivables | R0.00 |
| Customer receipts | R0.00 |
| Outstanding invoices | R0.00 |
| Outstanding liabilities | R0.00 |

Do not import any historical financial transactions, wage arrears, accommodation liabilities, loan balances or other expenditure from the previous contract.

Do not create artificial transactions simply to establish zero balances.

The worker register and confirmed standard pay rates are the only historical operational information being carried forward.

The existence of workers in the worker register must not automatically create attendance, wages earned, payroll liabilities or expenditure.

Financial transactions will commence when the next contract starts and actual transactions are entered into WorkTrack.

Do not generate cash flow forecasts based solely on the existence of workers.

Forecasts must be based on actual job plans and explicitly defined financial assumptions.

### 5.4 Reset and worker import acceptance criteria

Following the reset and worker import:

- Exactly 13 active workers are present, subject to verification of the supplied worker list.
- Both Admin and Owner accounts can see the same workers.
- No previous jobs or operational transactions exist.
- No workers are automatically assigned to a fictitious job.
- All financial balances are zero.
- No fictitious cash shortfall appears on the dashboard.
- No fictitious planned job progress appears.
- No historical payroll or wage liabilities exist.
- No previous loan balances exist.
- No previous expenses or customer receipts exist.
- Refreshing the application or signing in from another device does not restore deleted demonstration data.
- Obsolete offline queues cannot restore deleted test transactions.
- The business is ready for the creation of its first new job.

Provide the exact commands required to perform the backup, reset, worker import and subsequent verification on my existing self-hosted VM.

## 6. Complete security and role-based access control

Review all database Row Level Security policies, API access permissions, database functions and frontend role restrictions.

Validate all three application roles:

- Admin.
- Owner.
- Supervisor.

Ensure that security is enforced at the database and API levels, not merely by hiding buttons or menu items in the browser.

In particular, verify:

- Users cannot access records belonging to another business.
- Supervisors can access only authorised jobs and related records where the specification requires job-level restrictions.
- Supervisors cannot approve their own payroll or bypass approval processes.
- Users cannot escalate their own permissions.
- Users cannot assign themselves to unauthorised jobs.
- User identities in audit records cannot be spoofed through client-supplied values.
- Inactive memberships lose access.
- Financial and approved historical records cannot be silently altered or deleted.
- Financial amendments follow appropriate authorisation and audit processes.
- The Supabase service role key is never embedded in the frontend bundle.
- Migration history cannot be read or altered by ordinary application users unless explicitly required and authorised.
- Business reset and bulk import procedures cannot be executed by unauthorised users.

Review migration F and the storage object RLS policies.

The current storage policies restrict access by business ID but do not necessarily restrict supervisors to their assigned jobs. Correct this where required by the original specification.

Review:

- Cross-business foreign-key references.
- Attachment-to-entity relationships.
- Notification permissions.
- Vehicle and defect permissions.
- Membership and role changes.
- Offline transaction authorisation.
- Storage object paths.
- Signed URL expiry.
- Security-definer functions and their execution permissions.

Validate that direct database and API requests cannot bypass the intended application permissions.

Conduct negative security tests, including attempts by users to access records that their role should not permit.

## 7. Authentication and user management

Complete the user administration functionality so that administrators can manage users through WorkTrack without routinely needing SSH access to the VM.

Implement secure server-side workflows for:

- Creating and inviting users.
- Assigning roles.
- Assigning users to jobs.
- Activating and deactivating memberships.
- Changing a user's email address through an appropriate verified process.
- Password changes.
- Password resets.
- Revoking access.

Privileged operations must be implemented through a properly authenticated and authorised server-side mechanism.

Do not expose the Supabase service role key to the browser.

Retain disabled public registration.

Provide instructions for configuring SMTP with self-hosted Supabase.

Until SMTP is configured, provide a secure administrative password recovery process without relying on email delivery.

Implement an authenticated password change facility that allows a signed-in user to change their password without requiring email delivery.

The current Vuyo test account uses one of my email addresses because Vuyo does not yet have his own email address.

Ensure that this account can subsequently be transferred to Vuyo's verified email address, or securely replaced, without losing business records or corrupting audit history.

## 8. Dashboard and usability

Review the application separately from the perspective of management and the business owner.

The Owner interface must be particularly easy to use on an Android mobile phone.

Prioritise:

- Logging daily work.
- Recording worker attendance.
- Recording overtime and exceptions.
- Capturing expenses.
- Photographing receipts.
- Completing truck safety checks.
- Capturing GPS job progress.
- Viewing wages outstanding.
- Recording payments to workers.
- Preparing and submitting weekly reports.

Ensure that operational information entered by the Owner becomes available to Management on another device once synchronised.

### 8.1 Worker and attendance management

Ensure that workers can be:

- Created.
- Edited.
- Activated and deactivated.
- Assigned to jobs.
- Assigned appropriate worker roles.
- Assigned appropriate daily, hourly or weekly pay rules.

Support bulk attendance capture for a work crew, with individual exceptions for:

- Absence.
- Partial days.
- Overtime.
- Different pay rules.
- Different duties or worker types.

Avoid requiring Vuyo to individually enter the same attendance information for every worker when the entire crew has worked the same hours.

### 8.2 Financial visibility

Provide clearly distinguishable views of:

- Wages earned.
- Wages paid.
- Wages outstanding.
- Expenses incurred.
- Expenses paid.
- Customer payments expected.
- Customer payments received.
- Loan balances.
- Cash available.
- Job profitability.
- Estimated future cash requirements.

Ensure that the business owner can easily see which workers are owed money and how much is outstanding once actual work has commenced.

### 8.3 Save and synchronisation feedback

Provide clear confirmation messages when records have been successfully saved to Supabase.

Distinguish between:

- Saved to the server.
- Saved locally and awaiting synchronisation.
- Synchronisation in progress.
- Synchronisation failed.
- Record requires attention.

Do not report that a record has been successfully synchronised when it is still stored only on the local device.

## 9. Deployment configuration

Maintain compatibility with the existing self-hosted environment.

The current deployment uses:

- /srv/worktrack/app
- /srv/worktrack/supabase/docker
- /var/backups/worktrack
- deploy/.env
- deploy/docker-compose.yml
- deploy/docker-compose.override.yml

The WorkTrack Docker Compose override connects the application to the existing external npm-proxy Docker network.

Supabase has a separate Docker Compose override connecting its Envoy API gateway to the same external network.

The Supabase override is located at:

`/srv/worktrack/supabase/docker/docker-compose.worktrack.yml`

Do not replace Nginx Proxy Manager, expose PostgreSQL publicly or require a separate reverse proxy.

Update deployment documentation to accommodate the current Supabase Envoy gateway rather than assuming Kong is the default.

The public API reverse proxy currently permits authentication, REST, storage and Realtime API paths while blocking the dashboard root and other paths.

If new functionality requires additional API paths or server-side endpoints, document the exact changes required. Do not recommend unrestricted public exposure of Supabase administrative services.

Ensure that application upgrade procedures preserve local Docker Compose overrides and environment files.

Review .dockerignore and .gitignore to ensure that sensitive environment files, database credentials, private keys and backups are excluded from build contexts and GitHub.

Ensure that:

- The application continues to run as a non-root container user.
- Container health checks remain operational.
- Container log rotation remains configured.
- Node.js 22 remains the production runtime.
- Application updates do not require restarting unrelated Docker containers.
- The existing Supabase data and configuration are preserved during application upgrades.
- Application service worker updates do not leave users indefinitely running obsolete versions.

Provide upgrade and rollback instructions.

## 10. Backup and disaster recovery

Complete and verify the backup and restore procedures for:

- PostgreSQL application data.
- Supabase authentication data.
- Supabase Storage evidence.
- Application environment configuration.
- Supabase configuration.
- Docker Compose overrides.
- Migration history.
- Database security policies and functions.

Ensure backups can be encrypted and stored securely outside the VM.

Provide a documented automated daily backup procedure, retention policy, backup validation and restore verification.

The restoration test must use an isolated test environment and must not overwrite the live WorkTrack database.

Backup procedures must account for the relationship between evidence metadata and actual Storage files.

Provide procedures for:

- Performing a manual backup.
- Scheduling automated backups.
- Checking whether backups have completed successfully.
- Detecting failed backups.
- Restoring the database.
- Restoring stored evidence.
- Restoring configuration files.
- Recovering the application following VM failure.
- Rolling back an unsuccessful application upgrade.

No destructive reset or database migration should be undertaken without an appropriate verified backup.

## 11. Acceptance testing

Do not consider WorkTrack production-ready until the following tests have passed.

### Deployment and infrastructure

1. Clean installation against a fresh self-hosted Supabase instance.
2. Upgrade of an existing installation with all eight migrations already applied.
3. Successful Linux Docker build using locked dependencies.
4. Preservation of the existing Docker Compose network overrides.
5. Preservation of existing business and authentication records during an upgrade.
6. Application and API connectivity through HTTPS.
7. Application rollback following an unsuccessful upgrade.

### Authentication and security

8. Admin login.
9. Owner login.
10. Supervisor login.
11. Correct role-based functionality and permissions.
12. Cross-business access restrictions.
13. Supervisor job-level access restrictions.
14. Prevention of unauthorised privilege escalation.
15. Inactive membership access revocation.
16. Private evidence storage access controls.
17. Password changes and account recovery.
18. Confirmation that privileged keys are absent from the frontend bundle.

### Business reset and worker register

19. Successful backup before business reset.
20. Accurate reset dry-run output.
21. Business-specific reset without affecting other tenants.
22. Successful import of the 13 verified workers.
23. Worker import repeatability without duplication.
24. Zero opening financial balances.
25. No historical payroll, wage liabilities, expenses, loans or customer transactions.
26. Empty business dashboard with no fictitious financial or operational data.
27. Confirmation that previously cleared data cannot reappear through localStorage or offline synchronisation.
28. Cross-device worker register persistence.

### Operational functionality

29. Cross-device job and assessment persistence.
30. GPS waypoint capture and route distance calculation.
31. Daily work and progress capture.
32. Bulk worker attendance capture.
33. Individual attendance exceptions.
34. Overtime calculations.
35. Daily and weekly pay rule calculations.
36. Payroll calculation and approval.
37. Partial wage payments and correct remaining balances.
38. Expenses and receipt uploads.
39. Customer payment and cash flow reconciliation.
40. Loan drawdown and repayment reconciliation.
41. Job profitability calculation.
42. Vehicle safety checks and critical defect handling.
43. Weekly report creation, submission, approval and revision.
44. Notification creation and acknowledgement across devices.

### Mobile and offline functionality

45. Mobile installation as a PWA.
46. GPS capture on Android.
47. Camera and receipt capture on Android.
48. Offline capture followed by successful synchronisation.
49. Duplicate transaction prevention.
50. Offline queue persistence across application restarts.
51. Appropriate handling of synchronisation conflicts.
52. Service worker update behaviour.
53. Correct synchronisation status indicators.
54. Cross-device visibility of newly synchronised records.

### Backup and recovery

55. Successful database backup.
56. Successful evidence storage backup.
57. Successful isolated database restoration.
58. Successful evidence restoration.
59. Recovery of application configuration.
60. Validation of restored data and security policies.

Include automated tests where practical and document any tests that still require manual verification.

Use isolated test businesses or environments when executing tests that create financial or operational transactions.

Do not leave acceptance test transactions in the live Vuyo Contracting business.

Do not claim that a test has passed unless it has actually been executed successfully.

For each test, record:

- Test description.
- Expected result.
- Actual result.
- Pass, fail or not executed.
- Supporting evidence where available.
- Outstanding corrective action if applicable.

## 12. Required deliverables

Update the GitHub repository with all corrected application code.

Provide:

- A summary of completed changes.
- A list of all modified and newly created files.
- New database migrations required for the existing installation.
- A controlled business data reset script.
- A controlled worker register import script.
- Dry-run and actual reset instructions.
- Dry-run and actual worker import instructions.
- Updated deployment and upgrade instructions.
- Updated rollback instructions.
- Updated backup and restore instructions.
- Updated configuration documentation.
- Security review findings.
- Acceptance test results.
- Any remaining known defects or limitations.
- Exact commands required to upgrade my existing VM installation.

The upgrade procedure must accommodate the fact that the VM currently contains manually corrected versions of:

- Dockerfile
- db/migrations/202611270006_increment_e_reports_vehicles_notifications.sql
- deploy/scripts/create-user.sh

It must also preserve the locally created Docker Compose override files.

Do not recommend an unconditional git reset --hard, database reset, destructive migration or removal of existing configuration files.

Where changes require additional credentials or configuration, explain how they must be supplied securely without including secrets in GitHub.

Provide a clear distinction between:

- Application code changes.
- New database migrations.
- Infrastructure configuration changes.
- One-time administrative operations.
- Routine operational processes.
- Manual acceptance tests.

## 13. Implementation approach

Work through the existing application systematically.

Prioritise the work in the following order:

1. Incorporate the deployment corrections into the source code.
2. Resolve incomplete database persistence.
3. Correct the financial calculations and remove fictitious data.
4. Complete offline synchronisation and evidence functionality.
5. Review and correct security and access controls.
6. Complete user administration and password management.
7. Implement the controlled business reset and worker import scripts.
8. Complete backup, restore and upgrade procedures.
9. Execute automated acceptance tests.
10. Document remaining manual acceptance tests and any limitations.

Do not unnecessarily redesign or replace working functionality.

Preserve the existing application architecture, business requirements and self-hosted deployment model.

Where an implementation decision materially changes the original specification, explain that decision.

If any requirement cannot be fully implemented or tested within the Lovable environment, identify it explicitly and provide the exact steps required to complete or verify it on my VM.

Do not conceal incomplete functionality behind demonstration data, browser-local fallback behaviour or optimistic status indicators.

Complete the actual implementation, not just an implementation plan.

## 14. Final expected outcome

The objective is a reliable, secure, fully functional, self-hosted WorkTrack application that can be used by Vuyo Contracting for real operational and financial management.

At the point of handover:

- The application is deployed to my existing VM.
- Supabase is the authoritative source of business data.
- My administrator account remains operational.
- Vuyo's Owner account remains operational.
- All application functionality is shared across authorised devices.
- The worker register is populated with the verified 13 workers.
- No historical financial transactions or liabilities are carried forward.
- All opening financial balances are zero.
- No previous jobs or operational transactions are present.
- No demonstration data appears in production.
- Security controls have been tested.
- Backup and recovery procedures are operational.
- The application is ready for the creation and management of Vuyo Contracting's next job.

The next job will represent the starting point for all actual operational and financial transactions within WorkTrack.