import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export type RecordText = { text: string; date?: string; session?: string; at?: string };
export type Observation = { kind: '原话' | '纠正'; quote: string; doing: string; insight: string };
type Source = { name: string; records: RecordText[]; matchName?: string; memory?: boolean };
type Match = { name: string; date?: string; session?: string; memory?: boolean };
type Entry = {
  id: string;
  quotes: string[];
  end: number;
  newline: string;
  status: 'found' | 'missing' | 'checked' | 'no-quote';
  location?: Match;
  usedMemory?: boolean;
};

function* jsonLines(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A session can be read while its last line is still being written.
      yield null;
    }
  }
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

export function localDate(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
}

function add(records: RecordText[], text: unknown, timestamp?: unknown, session?: string) {
  if (typeof text !== 'string' || !text.trim()) return;
  const time = typeof timestamp === 'number' || typeof timestamp === 'string'
    ? new Date(timestamp)
    : undefined;
  records.push({ text, date: time && localDate(time), session, at: Number.isFinite(time?.getTime()) ? time!.toISOString() : undefined });
}

export function loadSources(home: string, extra: string[] = [], workbenchDirs: string[] = [], sessionsOnly = false): Source[] {
  const files = (pattern: string, cwd = home) => globSync(pattern, { cwd }).sort().map(path => join(cwd, path));
  const claude: RecordText[] = [];
  for (const path of files('.claude/projects/**/*.jsonl')) {
    for (const row of jsonLines(path)) {
      if (row?.type !== 'user' || row.isMeta || row.isCompactSummary || row.isSidechain ||
          row.entrypoint === 'sdk-cli' || (row.turnOrigin != null && row.turnOrigin !== 'human')) continue;
      const text = textContent(row.message?.content)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trimStart();
      if (!/^<(?:task-notification|local-command)/.test(text)) add(claude, text, row.timestamp, row.sessionId ?? basename(path, '.jsonl'));
    }
  }
  const codex: RecordText[] = [];
  for (const path of [...files('.codex/sessions/**/*.jsonl'), ...files('.codex/archived_sessions/**/*.jsonl')]) {
    const rows = jsonLines(path);
    const meta = rows.next().value;
    if (meta?.type !== 'session_meta' || !['cli', 'vscode'].includes(meta.payload?.source)) continue;
    for (const row of rows) {
      if (row?.type !== 'event_msg') continue;
      const payload = row.payload;
      if (payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') {
        add(codex, textContent(payload.item.content), row.timestamp, meta.payload.id);
      } else if (payload?.type === 'user_message') {
        add(codex, payload.message, row.timestamp, meta.payload.id);
      }
    }
  }
  const antigravity: RecordText[] = [];
  for (const app of ['antigravity', 'antigravity-ide']) {
    for (const path of files(`.gemini/${app}/brain/*/.system_generated/logs/transcript.jsonl`)) {
      const session = basename(dirname(dirname(dirname(path))));
      for (const row of jsonLines(path)) {
        if (row?.type !== 'USER_INPUT' || row.source !== 'USER_EXPLICIT') continue;
        const request = textContent(row.content).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        add(antigravity, request?.[1].trim(), row.created_at, session);
      }
    }
  }
  const antigravitySource = { name: 'Antigravity', records: antigravity };
  if (sessionsOnly) return [
    { name: 'Claude Code', records: claude },
    { name: 'Codex', records: codex },
    antigravitySource,
  ];

  const claudeHistory: RecordText[] = [];
  for (const row of jsonLines(join(home, '.claude/history.jsonl'))) {
    add(claudeHistory, row?.display, row?.timestamp, row?.sessionId);
  }

  const codexHistory: RecordText[] = [];
  for (const row of jsonLines(join(home, '.codex/history.jsonl'))) {
    add(codexHistory, row?.text, typeof row?.ts === 'number' ? row.ts * 1000 : undefined, row?.session_id);
  }

  const workbench: RecordText[] = [];
  const conversationFiles = [join(home, '.local/share/sic/app'), ...workbenchDirs]
    .flatMap(directory => files('conversations/*.json', resolve(directory)));
  for (const path of new Set(conversationFiles)) {
    const conversation = JSON.parse(readFileSync(path, 'utf8'));
    for (const chat of [conversation.chat, ...(conversation.turns ?? []).map(turn => turn.chat)]) {
      for (const message of chat ?? []) {
        if (message.role === 'human') add(workbench, message.text, message.at, basename(path, '.json'));
      }
    }
  }

  return [
    { name: 'Claude Code', records: claude },
    { name: 'Claude Code 输入历史', matchName: 'Claude Code', records: claudeHistory },
    { name: 'Codex', records: codex },
    { name: 'Codex 输入历史', matchName: 'Codex', records: codexHistory },
    antigravitySource,
    { name: '工作台', records: workbench },
    ...extra.map(path => ({ name: basename(path), records: [{ text: readFileSync(path, 'utf8') }] })),
    { name: 'Claude Code 记忆', memory: true, records: files('.claude/projects/*/memory/**/*.md')
      .map(path => ({ text: readFileSync(path, 'utf8') })) },
    { name: 'Codex 记忆', memory: true, records: files('.codex/memories/**/*.md')
      .map(path => ({ text: readFileSync(path, 'utf8') })) },
  ];
}

const compact = (text: string) => text.replace(/\s/gu, '');

function contains(text: string, parts: string[]): boolean {
  let offset = 0;
  for (const part of parts) {
    const index = text.indexOf(part, offset);
    if (index === -1) return false;
    offset = index + part.length;
  }
  return true;
}

export function verifyLog(log: string, sources: Source[]): Entry[] {
  const records = sources.flatMap(source => source.records.map(record => ({
    text: compact(record.text),
    location: {
      name: source.matchName ?? source.name,
      date: record.date,
      session: record.session,
      memory: source.memory,
    },
  })));
  const human = records.filter(record => !record.location.memory);
  const memory = records.filter(record => record.location.memory);
  const headings = [...log.matchAll(/^## (.+)$/gm)];

  return headings.map((heading, index) => {
    const fields = heading[1].split(' · ');
    const section = log.slice(heading.index, headings[index + 1]?.index);
    const end = heading.index + section.replace(/(?:\r?\n[^\S\r\n]*)+$/, '').length;
    const quotes = [...section.matchAll(/^(?:> [^\r\n]*(?:\r?\n(?=> ))?)+/gm)]
      .map(match => match[0].replace(/^> /gm, '').replace(/\r\n/g, '\n'));
    const entry: Entry = {
      id: fields[0],
      quotes,
      end,
      newline: section.match(/\r?\n/)?.[0] ?? '\n',
      status: 'no-quote',
    };
    if (/^核对（/m.test(section)) return { ...entry, status: 'checked' };
    if (!quotes.length) return entry;

    const transcript = fields.at(-1)?.startsWith('转录');
    const locations = quotes.map(quote => {
      const parts = compact(quote).split('……').filter(Boolean);
      if (!parts.length) return undefined;
      const matches = record => contains(record.text, parts);
      return (human.find(matches) ?? (transcript ? memory.find(matches) : undefined))?.location;
    });
    if (locations.some(location => !location)) return { ...entry, status: 'missing' };
    return {
      ...entry,
      status: 'found',
      location: locations[0],
      usedMemory: locations.some(location => location?.memory),
    };
  });
}

function foundAt(entry: Entry): string {
  if (entry.location?.memory) return '在 AI 的记忆里找到，不是 TA 亲手打的。';
  const { name, date, session } = entry.location!;
  return `在 ${name}${date ? ` ${date}` : ''} 的记录里找到${session ? `，会话 ${session}` : ''}。`;
}

export function markLog(log: string, entries: Entry[], date: string): string {
  let result = '';
  let start = 0;
  for (const entry of entries) {
    if (entry.status !== 'found' && entry.status !== 'missing') continue;
    const message = entry.status === 'found' ? foundAt(entry) : '原始记录里找不到。';
    result += log.slice(start, entry.end) + entry.newline.repeat(2) + `核对（${date}）：${message}`;
    start = entry.end;
  }
  return result + log.slice(start);
}

export function addObservations(log: string, observations: Observation[], source: Source, who: string, date: string, today: string) {
  const singleLine = (text: string) => text.replace(/[\r\n]+/g, ' ');
  const existing = verifyLog(log, []);
  const quotes = existing.flatMap(entry => entry.quotes.map(compact));
  let id = existing.reduce((max, entry) => /^\d+$/.test(entry.id) ? Math.max(max, Number(entry.id)) : max, 0);
  const added: { id: number; quote: string }[] = [];
  const sections: string[] = [];
  for (const { kind, quote, doing, insight } of observations) {
    const key = compact(quote);
    if (quotes.some(existingQuote => key.includes(existingQuote) || existingQuote.includes(key))) continue;
    quotes.push(key);
    const lines = quote.split(/\r?\n/).filter(line => line.trim()).map(line => '> ' + line);
    added.push({ id: ++id, quote });
    sections.push(`## ${id} · ${date} · ${who}，${singleLine(doing)} · ${kind}\n${lines.join('\n')}\n\n看出：${singleLine(insight)}`);
  }
  if (!added.length) return { log, added };

  const separator = !log || /\r?\n[^\S\r\n]*\r?\n$/.test(log) ? '' : log.endsWith('\n') ? '\n' : '\n\n';
  const updated = log + separator + sections.join('\n\n') + '\n';
  const entries = verifyLog(updated, [source]);
  return { log: markLog(updated, entries.slice(existing.length), today), added };
}

export function verifyNote(note: string, log: string) {
  const headings = [...log.matchAll(/^## (\d+)(?= · |\r?$)/gm)];
  const conversations = new Map<string, string | undefined>();
  for (const [index, heading] of headings.entries()) {
    const section = log.slice(heading.index, headings[index + 1]?.index);
    const match = section.match(/^核对（[^）]+）：在 (.+?) 的记录里找到(?:，会话 (\S+))?。\r?$/m);
    // Old checks encode the source and optional date together.
    const conversation = match?.[2]
      ? JSON.stringify([match[1].replace(/ \d{4}-\d{2}-\d{2}$/, ''), match[2]])
      : match?.[1];
    conversations.set(heading[1], conversation);
  }

  const issues: { kind: string; line: number; conversations: number; excerpt: string }[] = [];
  const counts = { total: 0, sufficient: 0, insufficient: 0, marked: 0 };
  for (const [index, line] of note.split(/\r?\n/).entries()) {
    if (line.trimStart().startsWith('>') || line.includes('已认可')) continue;
    const ids = [...line.matchAll(/\[(\d+)\]/g)].map(match => match[1]);
    if (!ids.length) continue;
    const distinct = new Set(ids.map(id => conversations.get(id)).filter(Boolean)).size;
    const marked = line.includes('证据不足');
    const excerpt = [...line.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 30).join('');
    const detail = { line: index + 1, conversations: distinct, excerpt };
    counts.total++;
    if (distinct >= 2) {
      counts.sufficient++;
      if (marked) issues.push({ kind: '可以去掉标记', ...detail });
    } else if (marked) {
      counts.marked++;
    } else {
      counts.insufficient++;
      issues.push({ kind: '证据不足', ...detail });
    }
    if (ids.some(id => !conversations.has(id))) {
      issues.push({ kind: '见闻不存在', ...detail });
    }
  }
  return { ...counts, issues };
}

function main(): number {
  const { values } = parseArgs({ options: {
    log: { type: 'string' },
    home: { type: 'string' },
    note: { type: 'string' },
    source: { type: 'string', multiple: true },
    workbench: { type: 'string', multiple: true },
    mark: { type: 'boolean' },
  } });
  const home = values.home ?? homedir();
  const path = values.log ?? join(home, '.local/share/sic/identity/log.md');
  const log = readFileSync(path, 'utf8');
  const sources = loadSources(home, values.source, values.workbench);
  const entries = verifyLog(log, sources);
  const found = entries.filter(entry => entry.status === 'found');
  const missing = entries.filter(entry => entry.status === 'missing');
  const checked = entries.filter(entry => entry.status === 'checked');
  const noQuote = entries.filter(entry => entry.status === 'no-quote');

  const markedLog = markLog(log, entries, localDate(new Date()));
  if (values.mark && found.length + missing.length > 0) {
    writeFileSync(path, markedLog);
  }

  console.log(`共 ${entries.length} 条见闻，找到 ${found.length} 条（其中 ${found.filter(entry => entry.usedMemory).length} 条有引文只在 AI 的记忆里找到），没找到 ${missing.length} 条，已核对 ${checked.length} 条，没有原话 ${noQuote.length} 条。`);
  for (const entry of missing) {
    const excerpt = [...entry.quotes.join(' ').replace(/\s+/g, ' ')].slice(0, 20).join('');
    console.log(`没找到 [${entry.id}] ${excerpt}`);
  }
  const summary = sources.map(source => {
    const dates = source.records.flatMap(record => record.date ? [record.date] : []).sort();
    return `${source.name} ${source.records.length} 条（${dates.length ? `${dates[0]} 至 ${dates.at(-1)}` : '无日期'}）`;
  });
  console.log(`查过的记录：${summary.join('、')}`);
  const notePath = values.note ?? join(dirname(path), 'me.md');
  if (existsSync(notePath)) {
    const note = verifyNote(readFileSync(notePath, 'utf8'), markedLog);
    console.log(`共 ${note.total} 条判断，证据够 ${note.sufficient} 条，证据不足 ${note.insufficient} 条，已标 ${note.marked} 条。`);
    for (const issue of note.issues) {
      console.log(`${issue.kind} ${basename(notePath)} 第 ${issue.line} 行（${issue.conversations} 次对话） ${issue.excerpt}`);
    }
    if (note.insufficient || note.issues.some(issue => issue.kind === '见闻不存在')) return 1;
  }
  return !values.mark && missing.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
