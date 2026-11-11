import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArtifactTools, type ArtifactStore } from '../src/artifacts.js';
import { createLocalExecutionSandbox, prepareSandbox } from '../src/sandbox.js';

test('產出可包含二進位資料，拒絕目錄跳脫、symlink、過大檔案及檔案數量超限', async t => {
  const runtime = await createLocalExecutionSandbox(new AbortController().signal);
  t.after(() => runtime.stop());
  await prepareSandbox(runtime, [], new AbortController().signal);
  const { sandbox } = runtime;
  const files: ArtifactStore = new Map();
  const tools = createArtifactTools(crypto.randomUUID(), sandbox, files);
  const options = { toolCallId: 'test', messages: [], context: {} };
  const binary = Uint8Array.from([0, 255, 128, 12]);
  await sandbox.writeBinaryFile({ path: '/workspace/output/檔案.bin', content: binary });
  const result = await tools.publishFile.execute!({ path: '/workspace/output/檔案.bin' }, options);
  assert.match(JSON.stringify(result), /檔案.bin/);
  assert.deepEqual(Array.from([...files.values()][0]?.content ?? []), Array.from(binary));
  await sandbox.writeTextFile({ path: '/workspace/private.txt', content: 'private' });
  await sandbox.run({ command: 'ln -s /workspace/private.txt /workspace/output/escape.txt' });
  for (const path of ['/workspace/private.txt', '/workspace/output/../private.txt', '/workspace/output/escape.txt', '/workspace/output/missing.txt']) {
    await assert.rejects(async () => tools.publishFile.execute!({ path }, options));
  }
  await sandbox.writeBinaryFile({ path: '/workspace/output/large.bin', content: new Uint8Array(10 * 1024 * 1024 + 1) });
  await assert.rejects(async () => tools.publishFile.execute!({ path: '/workspace/output/large.bin' }, options));
  for (let index = 0; index < 9; index++) await tools.publishFile.execute!({ path: '/workspace/output/檔案.bin' }, options);
  await assert.rejects(async () => tools.publishFile.execute!({ path: '/workspace/output/檔案.bin' }, options));
});
