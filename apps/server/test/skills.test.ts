import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { createChatAgent } from '../src/agent.js';
import { createApp } from '../src/app.js';
import { buildSkillsPrompt, createSkillTools, discoverSkills } from '../src/skills.js';
import { mockStream, serve, textStream, userMessage } from './helpers.js';

test('技能目錄只放入名稱與用途，模型需要時才載入指示與參考檔', async t => {
  const skills = await discoverSkills();
  assert.equal(skills.length, 1);
  assert.match(buildSkillsPrompt(skills), /clear-answer/);
  assert.doesNotMatch(buildSkillsPrompt(skills), /先用一至兩句話/);
  const model = new MockLanguageModelV4({ doStream: [
    mockStream([{ type: 'tool-call', toolCallId: 'skill-1', toolName: 'loadSkill', input: '{"name":"clear-answer"}' }], 'tool-calls'),
    mockStream([{ type: 'tool-call', toolCallId: 'file-1', toolName: 'readSkillFile', input: '{"name":"clear-answer","path":"references/answer-template.md"}' }], 'tool-calls'),
    textStream('已依技能整理回答。'),
  ] });
  const url = await serve(t, createApp(createChatAgent(model, skills)));
  const response = await fetch(`${url}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [userMessage] }),
  });
  const stream = await response.text();
  assert.match(stream, /已依技能整理回答/);
  assert.equal(model.doStreamCalls.length, 3);
  assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]?.prompt), /先用一至兩句話/);
  assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /先用一至兩句話/);
  assert.match(JSON.stringify(model.doStreamCalls[2]?.prompt), /問題很簡單時/);
});

test('檔案工具拒絕未知技能、路徑跳脫、junction 與過大檔案', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'chat-skills-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'skills');
  const skillDirectory = join(root, 'example');
  const outside = join(fixture, 'private');
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: example\ndescription: |\n  測試用途\n---\n指示內容');
  await writeFile(join(outside, 'secret.txt'), 'outside-secret');
  await writeFile(join(skillDirectory, 'large.txt'), 'x'.repeat(65_537));
  await symlink(outside, join(skillDirectory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const skills = await discoverSkills(root);
  const tools = createSkillTools(skills);
  const options = { toolCallId: 'test', messages: [], context: {} };
  assert.match(JSON.stringify(await tools.loadSkill.execute!({ name: 'example' }, options)), /指示內容/);
  await assert.rejects(async () => tools.loadSkill.execute!({ name: 'missing' }, options));
  for (const path of ['../../private/secret.txt', join(outside, 'secret.txt'), 'escape/secret.txt', 'large.txt']) {
    await assert.rejects(async () => tools.readSkillFile.execute!({ name: 'example', path }, options));
  }
});

test('技能 metadata 錯誤時啟動失敗，不靜默忽略', async t => {
  const root = await mkdtemp(join(tmpdir(), 'invalid-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'example');
  await mkdir(directory);
  for (const content of [
    '# 沒有 frontmatter',
    '---\nname: wrong-name\ndescription: test\n---\nbody',
    '---\nname: example\n---\nbody',
    '---\nname: example\nname: example\ndescription: test\n---\nbody',
  ]) {
    await writeFile(join(directory, 'SKILL.md'), content);
    await assert.rejects(discoverSkills(root));
  }
});
