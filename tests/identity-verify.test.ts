import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadSources, markLog, verifyLog, verifyNote } from '../scripts/verify-log.ts';

const date = '2026-03-04';
const session = '01a206d1-2fec-7bd3-9611-1c82a629cb17';
const otherSession = '01a206d1-2fec-7bd3-9611-1c82a629cb18';
const timestamp = date + 'T00:30:00Z';
const expectedDate = new Date(timestamp).toLocaleDateString('en-CA');

function fakeHome(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'identity-verify-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  function write(relative: string, contents: string) {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
  }
  return { home, write, jsonl: (path: string, rows: unknown[]) =>
    write(path, rows.map(row => JSON.stringify(row)).join('\n')) };
}

function logOf(quotes: string[], kind = '原话') {
  return quotes.map((quote, index) => `## ${index + 1} · ${date} · 测试 · ${kind}\n> ${quote}\n`).join('\n');
}

test('Claude Code 排除助手、工具、程序调用和系统内容', t => {
  const { home, jsonl } = fakeHome(t);
  const user = (content: unknown, fields = {}) => ({
    type: 'user', timestamp, message: { content }, ...fields,
  });
  jsonl('.claude/projects/example/nested/run.jsonl', [
    user([{ type: 'text', text: '蓝色月亮' }, { type: 'tool_result', content: '工具回执' }], { turnOrigin: 'human', sessionId: session }),
    user('白色月亮<system-reminder>提醒内容</system-reminder>升起', { turnOrigin: null }),
    user('助手回答', { type: 'assistant' }),
    user('旁支内容', { isSidechain: true }),
    user('程序输入', { entrypoint: 'sdk-cli' }),
    user(' <task-notification>任务通知</task-notification>'),
    user('<local-command-output>命令输出</local-command-output>'),
    user('元信息', { isMeta: true }),
    user('压缩摘要', { isCompactSummary: true }),
    user('后台输入', { turnOrigin: 'automation' }),
  ]);
  jsonl('.claude/history.jsonl', [{ display: '历史月亮', sessionId: session, timestamp: Date.parse(timestamp) }]);
  const entries = verifyLog(logOf([
    '蓝色月亮', '白色月亮升起', '历史月亮', '工具回执', '助手回答', '旁支内容',
    '程序输入', '任务通知', '命令输出', '提醒内容', '元信息', '压缩摘要', '后台输入',
  ]), loadSources(home));
  assert.deepEqual(entries.map(entry => entry.status), [
    'found', 'found', 'found', ...Array(10).fill('missing'),
  ]);
  assert.deepEqual(entries.slice(0, 3).map(entry => entry.location?.session), [session, 'run', session]);
  assert.equal(entries[2].location?.name, 'Claude Code');
  assert.equal(entries[2].location?.date, expectedDate);
});

test('Codex 读取交互会话和输入历史', t => {
  const { home, jsonl } = fakeHome(t);
  const meta = (source: unknown, id = session) => ({ type: 'session_meta', payload: { source, id } });
  const event = (text: string) => ({
    type: 'event_msg', timestamp,
    payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } },
  });
  jsonl('.codex/sessions/2026/03/run.jsonl', [
    meta('vscode'), event('编辑器输入'),
    { ...event('注入内容'), type: 'response_item' },
  ]);
  jsonl('.codex/sessions/exec.jsonl', [meta('exec'), event('执行器输入')]);
  jsonl('.codex/sessions/object.jsonl', [meta({}), event('程序会话')]);
  jsonl('.codex/archived_sessions/2026/old.jsonl', [
    meta('cli', otherSession), { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '旧版输入' } },
  ]);
  jsonl('.codex/history.jsonl', [{ text: '历史输入', session_id: session, ts: Date.parse(timestamp) / 1000 }]);
  const entries = verifyLog(logOf([
    '编辑器输入', '旧版输入', '历史输入', '注入内容', '执行器输入', '程序会话',
  ]), loadSources(home));
  assert.deepEqual(entries.map(entry => entry.status), ['found', 'found', 'found', 'missing', 'missing', 'missing']);
  assert.deepEqual(entries.slice(0, 3).map(entry => entry.location?.session), [session, otherSession, session]);
  assert.equal(entries[2].location?.name, 'Codex');
  assert.equal(entries[2].location?.date, expectedDate);
});

test('转录优先查人的原话，并可回查两家的记忆', t => {
  const { home, write } = fakeHome(t);
  write('.codex/memories/project/note.md', '记忆里的纸船，共有词');
  write('.claude/projects/example/memory/note.md', '记忆里的风筝');
  const extra = write('typed.txt', '共有词');
  const quotes = ['记忆里的纸船', '记忆里的风筝', '共有词'];
  const sources = loadSources(home, [extra]);
  const entries = verifyLog(logOf(quotes, '转录（测试）'), sources);
  assert.deepEqual(entries.map(entry => entry.location?.name), ['Codex 记忆', 'Claude Code 记忆', 'typed.txt']);
  assert.deepEqual(verifyLog(logOf(quotes), sources).map(entry => entry.status), ['missing', 'missing', 'found']);
});

test('工作台只查人的发言，省略号两边须在同条记录内顺序出现', t => {
  const { home, write } = fakeHome(t);
  write('.local/share/sic/app/conversations/test.json', JSON.stringify({
    chat: [
      { role: 'human', text: '纸 船\t顺 流而下', at: timestamp },
      { role: 'human', text: '孤岛' },
      { role: 'assistant', text: '助手的纸船' },
    ],
    turns: [{ chat: [{ role: 'human', text: '海岸' }] }],
  }));
  write('other-workbench/conversations/other.json', JSON.stringify({
    chat: [{ role: 'human', text: '另一个工作台的输入' }],
  }));
  const transcript = 'e7ee9f74-c0bb-414c-9520-000000000001/.system_generated/logs/transcript.jsonl';
  const userRow = {
    type: 'USER_INPUT', source: 'USER_EXPLICIT', created_at: timestamp,
    content: '<USER_REQUEST>  选木轮\n再上色  </USER_REQUEST><ADDITIONAL_METADATA>系统附注</ADDITIONAL_METADATA>',
  };
  write(`.gemini/antigravity/brain/${transcript}`, [
    userRow,
    { ...userRow, type: 'PLANNER_RESPONSE', content: '<USER_REQUEST>模型的话</USER_REQUEST>' },
    { ...userRow, content: '没有标签的输入' },
    { ...userRow, source: 'SYSTEM', content: '<USER_REQUEST>系统输入</USER_REQUEST>' },
  ].map(row => JSON.stringify(row)).join('\n'));
  write(`.gemini/antigravity-cli/brain/${transcript}`, JSON.stringify({
    ...userRow, content: '<USER_REQUEST>命令行输入</USER_REQUEST>',
  }));
  const sources = loadSources(home, [], [join(home, 'other-workbench')]);
  assert.deepEqual(sources.find(source => source.name === 'Antigravity')?.records, [{
    text: '选木轮\n再上色', date: expectedDate, at: new Date(timestamp).toISOString(),
    session: 'e7ee9f74-c0bb-414c-9520-000000000001',
  }]);
  const entries = verifyLog(logOf([
    '纸船\n> 顺流', '纸船……而下', '而下……纸船', '孤岛……海岸', '海岸', '助手的纸船',
    '另一个工作台的输入',
  ]), sources);
  assert.deepEqual(entries.map(entry => entry.status), ['found', 'found', 'missing', 'missing', 'found', 'missing', 'found']);
  assert.equal(entries[0].location?.date, expectedDate);
  assert.equal(entries[4].location?.date, undefined);
  assert.equal(entries[6].location?.name, '工作台');
  assert.deepEqual([0, 4, 6].map(index => entries[index].location?.session), ['test', 'test', 'other']);
});

test('只给有原话的未核对见闻插入核对行，保留文件原有内容', t => {
  const { home, write } = fakeHome(t);
  const extra = write('typed.txt', '有出处');
  write('.codex/memories/test.md', '记忆引文');
  write('.codex/history.jsonl', JSON.stringify({ text: '会话引文', session_id: session }));
  const log = [
    '# 见闻', '> 开头说明', '', '## 1 · 测试 · 原话', '> 有出处', '', '> 有出处',
    '看出：保留行末空格  ', '  ', '', '## 2 · 测试 · 纠正', '> 缺少出处',
    '', '## 3 · 测试 · 原话', '> 已查过', '核对（旧日期）：已查。', '',
    '## 4 · 测试 · 反应', '看出：有反应。', '', '## 5 · 测试 · 转录', '> 记忆引文',
    '', '## 6 · 测试 · 原话', '> 会话引文',
  ].join('\r\n');
  const sources = loadSources(home, [extra]);
  const entries = verifyLog(log, sources);
  assert.deepEqual(entries.map(entry => entry.status), ['found', 'missing', 'checked', 'no-quote', 'found', 'found']);
  const marked = markLog(log, entries, date);
  assert.equal(marked, log
    .replace('看出：保留行末空格  ', `$&\r\n\r\n核对（${date}）：在 typed.txt 的记录里找到。`)
    .replace('> 缺少出处', `$&\r\n\r\n核对（${date}）：原始记录里找不到。`)
    .replace('> 记忆引文', `$&\r\n\r\n核对（${date}）：在 AI 的记忆里找到，不是 TA 亲手打的。`)
    .replace('> 会话引文', `$&\r\n\r\n核对（${date}）：在 Codex 的记录里找到，会话 ${session}。`));
  assert.equal(markLog(marked, verifyLog(marked, sources), date), marked);
});

test('判断需要两次不同对话，报告缺证据、过时标记和不存在的见闻', () => {
  const log = [
    `在 Codex 2026-03-03 的记录里找到，会话 ${session}。`,
    `在 Codex 2026-03-04 的记录里找到，会话 ${session}。`,
    `在 Codex 2026-03-04 的记录里找到，会话 ${otherSession}。`,
    '在 AI 的记忆里找到，不是 TA 亲手打的。',
    '原始记录里找不到。',
    undefined,
    '在 Claude Code 2026-03-03 的记录里找到。',
    '在 Claude Code 2026-03-03 的记录里找到。',
    '在 Claude Code 2026-03-04 的记录里找到。',
    '在 typed.txt 的记录里找到。',
    '在 typed.txt 的记录里找到。',
  ].map((check, index) => [
    `## ${index + 1} · 测试`,
    check ? `> 示例原话\n核对（${date}）：${check}` : '看出：没有原话。',
  ].join('\n')).join('\n\n');
  const note = [
    '> 说明里的 [编号] 和 [99]',
    '| 两次对话 | 证据 [1][3] |',
    '|  同一次对话   | 证据 [1][2][1] |',
    '- 无有效对话 [4][5][6]',
    '- 已认可 [99]',
    '1. 证据不足 [1]',
    '现在证据够了，证据不足 [2][3]',
    '- 同来源同日 [7][8]',
    '- 同来源不同日 [7][9]',
    '- 无日期的同来源 [10][11]',
    '- 有两个会话也要报告不存在的见闻 [1][3][99]',
  ].join('\r\n');

  assert.deepEqual(verifyNote(note, log), {
    total: 9, sufficient: 4, insufficient: 4, marked: 1,
    issues: [
      { kind: '证据不足', line: 3, conversations: 1, excerpt: '同一次对话 证据 [1][2][1]' },
      { kind: '证据不足', line: 4, conversations: 0, excerpt: '- 无有效对话 [4][5][6]' },
      { kind: '可以去掉标记', line: 7, conversations: 2, excerpt: '现在证据够了，证据不足 [2][3]' },
      { kind: '证据不足', line: 8, conversations: 1, excerpt: '- 同来源同日 [7][8]' },
      { kind: '证据不足', line: 10, conversations: 1, excerpt: '- 无日期的同来源 [10][11]' },
      { kind: '见闻不存在', line: 11, conversations: 2, excerpt: '- 有两个会话也要报告不存在的见闻 [1][3][99]' },
    ],
  });
});
