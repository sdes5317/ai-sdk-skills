import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJustBashNetworkSandboxSession } from '@ai-sdk/sandbox-just-bash';
import { collectSkillFiles, discoverSkills } from '../src/skills.js';
import { createLocalExecutionSandbox, prepareSandbox } from '../src/sandbox.js';

test('官方 Bash 工具能執行巢狀技能腳本，且二進位 assets 完整保留', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'example');
  await mkdir(join(directory, 'scripts', 'nested'), { recursive: true });
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'SKILL.md'), '---\nname: example\ndescription: test\n---\nRun the script.');
  await writeFile(join(directory, 'scripts', 'nested', 'report.sh'), 'printf "report-ready" > /workspace/output/report.txt\n');
  const binary = Uint8Array.from([0, 255, 128, 10]);
  await writeFile(join(directory, 'assets', 'template.bin'), binary);
  await writeFile(join(directory, '.env'), 'must-not-be-copied');
  const skills = await discoverSkills(root);
  const session = await createJustBashNetworkSandboxSession();
  t.after(() => session.destroy());
  const sandbox = session.restricted();
  const bash = await prepareSandbox({ sandbox, stop: () => session.destroy() }, skills, new AbortController().signal);
  const result = await bash.execute({ command: 'bash /workspace/skills/example/scripts/nested/report.sh && cat output/report.txt' }, { toolCallId: 'test', messages: [], context: {} });
  assert.ok('exitCode' in result);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /report-ready/);
  assert.deepEqual(await sandbox.readBinaryFile({ path: '/workspace/skills/example/assets/template.bin' }), Buffer.from(binary));
  assert.equal(await sandbox.readTextFile({ path: '/workspace/skills/example/.env' }), null);
});

test('技能資源封裝拒絕 junction 與過大的二進位檔案', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'example');
  await mkdir(directory);
  await writeFile(join(directory, 'SKILL.md'), '---\nname: example\ndescription: test\n---\nbody');
  const skills = await discoverSkills(root);
  await writeFile(join(directory, 'large.bin'), new Uint8Array(5 * 1024 * 1024 + 1));
  await assert.rejects(collectSkillFiles(skills));
  await rm(join(directory, 'large.bin'));
  const outside = await mkdtemp(join(tmpdir(), 'sandbox-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectSkillFiles(skills));
});

test('本機環境不提供主機檔案、環境變數、網路與任意程式；Bash 可取消', async t => {
  const previous = process.env.CHAT_SANDBOX_TEST_SECRET;
  process.env.CHAT_SANDBOX_TEST_SECRET = 'host-only-marker';
  t.after(() => {
    if (previous === undefined) delete process.env.CHAT_SANDBOX_TEST_SECRET;
    else process.env.CHAT_SANDBOX_TEST_SECRET = previous;
  });
  const runtime = await createLocalExecutionSandbox(new AbortController().signal);
  t.after(() => runtime.stop());
  const bash = await prepareSandbox(runtime, [], new AbortController().signal);
  const options = { toolCallId: 'test', messages: [], context: {} };
  const unavailable = await bash.execute({ command: 'node --version; python3 --version; curl https://example.com' }, options);
  assert.ok('exitCode' in unavailable);
  assert.notEqual(unavailable.exitCode, 0);
  assert.doesNotMatch(unavailable.stdout, /Node.js|Python/);
  assert.equal(await runtime.sandbox.readTextFile({ path: '/host/package.json' }), null);
  const environment = await bash.execute({ command: 'printenv' }, options);
  assert.ok('stdout' in environment);
  assert.doesNotMatch(environment.stdout, /host-only-marker/);
  await assert.rejects(bash.execute({ command: 'sleep 10' }, { ...options, abortSignal: AbortSignal.timeout(20) }), { name: 'TimeoutError' });
});
