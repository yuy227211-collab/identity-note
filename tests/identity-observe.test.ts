import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { observe } from '../scripts/observe.ts';

const now = new Date('2026-03-04T03:00:00Z');
const old = '2026-03-04T00:30:00Z';
const since = '2026-03-04T00:00:00Z';
const date = new Date(old).toLocaleDateString('en-CA');
const original = '# 见闻\n\n## 8 · 示例\n> 已记风车\n';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'identity-observe-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const data = join(home, '.local/share/sic');
  const state = join(data, 'observe-state.json');
  const log = join(data, 'identity/log.md');
  const note = join(data, 'identity/me.md');
  const cwd = join(data, 'observe-cwd');
  const response = join(home, 'response.json');
  const input = join(home, 'calls.jsonl');
  const command = join(home, 'claude');
  function write(path: string, text: string, mode?: number) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
  }
  write(log, original);
  write(note, '证据不足：喜欢纸船。');
  write(command, `#!/bin/sh
exec "${process.execPath}" "${join(home, 'fake.cjs')}" "$@"
`, 0o700);
  write(join(home, 'fake.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
const call = { input: fs.readFileSync(0, 'utf8'), cwd: process.cwd(), args };
fs.appendFileSync(${JSON.stringify(input)}, JSON.stringify(call) + '\\n');
const response = fs.readFileSync(${JSON.stringify(response)}, 'utf8');
if (response === 'fail') {
  console.error('假的 Claude 失败');
  process.exit(7);
}
console.log(response);
`);
  const read = (path: string) => readFileSync(path, 'utf8');
  const reply = (...quotes: string[]) => write(response, JSON.stringify({
    structured_output: { observations: quotes.map(quote => ({
      kind: '原话', quote, doing: '编纸玩具', insight: '挑了自己喜欢的玩具。', why: 'new',
    })) },
  }));
  function session(source: 'Claude Code' | 'Codex' | 'Antigravity', id: string, messages: string[], timestamp = old) {
    if (source === 'Antigravity') {
      const rows = messages.map(content => ({
        type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: timestamp,
        content: `<USER_REQUEST>${content}</USER_REQUEST>`,
      }));
      write(join(home, '.gemini/antigravity-ide/brain', id, '.system_generated/logs/transcript.jsonl'),
        rows.map(row => JSON.stringify(row)).join('\n'));
      return;
    }
    const rows = source === 'Claude Code' ? messages.map(content => ({
      type: 'user', timestamp, sessionId: id, message: { content },
    })) : [
      { type: 'session_meta', payload: { source: 'cli', id } },
      ...messages.map(message => ({ type: 'event_msg', timestamp, payload: { type: 'user_message', message } })),
    ];
    const directory = source === 'Claude Code' ? '.claude/projects/sample' : '.codex/sessions/sample';
    write(join(home, directory, id + '.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  }
  return {
    home, state, log, note, cwd, response, read, reply, session,
    calls: () => existsSync(input) ? read(input).trim().split('\n').map(line => JSON.parse(line)) : [],
    run: (...args: string[]) => observe(['--home', home, '--claude', command, ...args], now),
  };
}

test('首次运行建状态，缺见闻文件时直接跳过', t => {
  const f = fixture(t);
  f.session('Claude Code', 'old', ['纸船', '风筝', '木轮']);
  assert.equal(f.run('--log', join(f.home, 'missing.md')), 0);
  assert.equal(existsSync(f.state), false);
  assert.equal(f.run(), 0);
  assert.deepEqual(JSON.parse(f.read(f.state)), { since: now.toISOString(), sessions: {} });
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.cwd), false);
  assert.equal(f.read(f.log), original);
});

test('处理已结束的两种会话，限制见闻并在续聊后只发送新输入', t => {
  const f = fixture(t);
  const messages = ['想做纸船', '换成风筝', '最后选木轮'];
  f.session('Claude Code', 'shared', messages);
  f.session('Antigravity', 'shared', ['已记风车', '另一个玩具是木轮', '就用积木']);
  f.session('Codex', 'short', ['短对话甲', '短对话乙']);
  f.session('Claude Code', 'active', ['继续甲', '继续乙', '继续丙'], '2026-03-04T02:59:00Z');
  f.reply('编造的话', '纸船', '风筝', '木轮');
  assert.equal(f.run('--since', since), 0);
  const log = f.read(f.log);
  assert.ok(log.includes(`## 9 · ${date} · Claude Code，编纸玩具 · 原话\n> 纸船`));
  assert.ok(log.includes(`在 Claude Code ${date} 的记录里找到，会话 shared。`));
  assert.ok(log.includes(`## 11 · ${date} · Antigravity，编纸玩具 · 原话\n> 木轮`));
  assert.ok(log.includes(`在 Antigravity ${date} 的记录里找到，会话 shared。`));
  assert.ok(!log.includes('编造的话'));
  assert.deepEqual(JSON.parse(f.read(f.state)).sessions, {
    'Claude Code shared': 3, 'Antigravity shared': 3, 'Codex short': 2,
  });
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cwd, f.cwd);
  assert.ok(calls[0].input.includes('## 识人笔记\n证据不足：喜欢纸船。'));
  assert.ok(calls[0].input.endsWith('1. 想做纸船\n2. 换成风筝\n3. 最后选木轮\n'));
  assert.equal(f.run(), 0);
  assert.equal(f.calls().length, 2);

  const longMessage = '被截掉的开头' + '甲'.repeat(30_000) + '已记风车';
  f.session('Claude Code', 'shared', [...messages, '被整句丢掉的话', longMessage, '补一句沙堡']);
  f.reply('被截掉的开头', '已记风车', '沙堡');
  assert.equal(f.run(), 0);
  assert.equal(f.calls().length, 3);
  const input = f.calls()[2].input;
  const prompt = readFileSync(new URL('../scripts/observe-prompt.md', import.meta.url), 'utf8');
  assert.ok(input.startsWith(prompt));
  assert.ok(input.includes('## 识人笔记\n证据不足：喜欢纸船。'));
  assert.equal(input.length, 30_000);
  assert.match(input, /\n2\. 甲+已记风车\n3\. 补一句沙堡\n$/);
  for (const omitted of ['想做纸船', '被整句丢掉的话', '被截掉的开头']) {
    assert.ok(!input.includes(omitted));
  }
  assert.equal(f.read(f.log).slice(log.length).match(/^## /gm)?.length, 1);
  assert.ok(f.read(f.log).includes('> 沙堡'));
});

test('Claude 失败保留重试机会，其余会话照常推进，预览保持文件原样', t => {
  const f = fixture(t);
  f.session('Claude Code', 'retry', ['方形木板', '圆孔', '三角形']);
  f.session('Codex', 'short', ['短句']);
  writeFileSync(f.response, 'fail');
  assert.equal(f.run('--since', since), 1);
  const state = f.read(f.state);
  assert.deepEqual(JSON.parse(state).sessions, { 'Codex short': 1 });
  assert.equal(f.read(f.log), original);

  f.reply('圆孔');
  assert.equal(f.run('--dry-run'), 0);
  assert.equal(f.read(f.state), state);
  assert.equal(f.read(f.log), original);
  const freshState = join(f.home, 'preview', 'state.json');
  assert.equal(f.run('--dry-run', '--since', since, '--state', freshState), 0);
  const previewCwd = join(dirname(freshState), 'observe-cwd');
  assert.deepEqual(readdirSync(dirname(freshState)), ['observe-cwd']);
  assert.deepEqual(readdirSync(previewCwd), []);
  assert.equal(f.calls()[2].cwd, previewCwd);
  assert.equal(f.run(), 0);
  assert.equal(f.calls().length, 4);
  assert.ok(f.read(f.log).includes('> 圆孔'));
});
