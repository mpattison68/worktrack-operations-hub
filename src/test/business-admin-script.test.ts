// @vitest-environment node
import {it,expect} from 'vitest';import {spawnSync} from 'node:child_process';
it('administration planning unit checks: allowlist, 13-worker register, dry-run and repeatability',()=>{
 const result=spawnSync('python3',['src/test/business_admin_checks.py'],{encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);expect(result.stderr).toContain('Ran 4 tests');
});
