import { spawnSync } from 'node:child_process';
import { appendFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addObservations, loadSources, localDate, type Observation, type RecordText } from './verify-log.ts';

type TimedRecord = RecordText & { at: string; date: string; session: string };
type State = { since: string; sessions: Record<string, number> };

const schema = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['observations'],
  properties: {
    observations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'quote', 'doing', 'insight', 'why'],
        properties: {
          kind: { enum: ['原话', '纠正'] },
          quote: { type: 'string' },
          doing: { type: 'string' },
          insight: { type: 'string' },
          why: { enum: ['new', 'contradicts', 'supports-weak'] },
        },
      },
    },
  },
});

function askClaude(command: string, model: string, cwd: string, input: string): Observation[] {
  const result = spawnSync(command, [
    '-p', '--output-format', 'json', '--json-schema', schema, '--model', model,
    '--tools', '', '--strict-mcp-config', '--no-session-persistence',
  ], { cwd, input, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `退出状态 ${result.status ?? result.signal}`);
  }
  const response = JSON.parse(result.stdout);
  if (response.is_error) throw new Error(response.result ?? 'Claude 返回错误');
  if (!Array.isArray(response.structured_output?.observations)) throw new Error('Claude 缺少见闻数组');
  return response.structured_output.observations;
}

function groupSessions(records: RecordText[]) {
  const sessions = new Map<string, TimedRecord[]>();
  for (const record of records) {
    if (!record.session || !record.at || !record.date) continue;
    const { session, at, date } = record;
    const group = sessions.get(session) ?? [];
    group.push({ ...record, session, at, date });
    sessions.set(session, group);
  }
  for (const group of sessions.values()) group.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return sessions;
}

export function observe(args = process.argv.slice(2), now = new Date()): number {
  const { values } = parseArgs({ args, options: {
    home: { type: 'string' },
    log: { type: 'string' },
    note: { type: 'string' },
    state: { type: 'string' },
    idle: { type: 'string', default: '30' },
    claude: { type: 'string', default: 'claude' },
    model: { type: 'string', default: 'sonnet' },
    since: { type: 'string' },
    'dry-run': { type: 'boolean' },
  } });
  const home = values.home ?? homedir();
  const logPath = values.log ?? join(home, '.local/share/sic/identity/log.md');
  if (!existsSync(logPath)) {
    console.log('找不到 log.md，跳过观察。');
    return 0;
  }
  const statePath = values.state ?? join(home, '.local/share/sic/observe-state.json');
  const dryRun = values['dry-run'];
  const hasState = existsSync(statePath);
  const state: State = hasState ? JSON.parse(readFileSync(statePath, 'utf8')) : {
    since: values.since ?? now.toISOString(), sessions: {},
  };
  const since = Date.parse(state.since);
  const idle = Number(values.idle);
  if (!Number.isFinite(since) || !Number.isFinite(idle) || idle < 0) {
    throw new Error('需要有效的 --since 时间和非负的 --idle 分钟数。');
  }
  function saveState() {
    if (dryRun) return;
    mkdirSync(dirname(statePath), { recursive: true });
    const pending = `${statePath}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify(state, null, 2) + '\n');
    renameSync(pending, statePath);
  }
  if (!hasState) {
    saveState();
    if (!values.since) {
      console.log('从现在开始记。');
      return 0;
    }
  }

  const notePath = values.note ?? join(dirname(logPath), 'me.md');
  const note = existsSync(notePath) ? readFileSync(notePath, 'utf8') : '';
  const prompt = readFileSync(new URL('./observe-prompt.md', import.meta.url), 'utf8');
  const introduction = `${prompt}\n\n## 识人笔记\n${note}\n\n## TA 在这次对话里打的话\n`;
  const claudeDir = join(dirname(statePath), 'observe-cwd');
  const command = values.claude.includes('/') ? resolve(values.claude) : values.claude;
  let previewLog = dryRun ? readFileSync(logPath, 'utf8') : '';
  let exitCode = 0;

  for (const { name, records } of loadSources(home, [], [], true)) {
    for (const [session, group] of groupSessions(records)) {
      const key = `${name} ${session}`;
      const last = group.at(-1)!;
      const lastAt = Date.parse(last.at);
      if (lastAt < since || now.getTime() - lastAt <= idle * 60_000) continue;
      const unseen = group.slice(state.sessions[key] ?? 0).filter(record => Date.parse(record.at) >= since);
      if (!unseen.length) continue;
      let added = 0;
      if (group.length > 2) {
        const lines = unseen.slice(-40).map((record, index) => ({ record, prefix: `${index + 1}. ` }));
        let remaining = 30_000 - introduction.length;
        const selected: typeof lines = [];
        for (const { record, prefix } of lines.reverse()) {
          const room = remaining - prefix.length - 1;
          if (room <= 0) break;
          const text = record.text.slice(-room);
          selected.push({ record: { ...record, text }, prefix });
          remaining -= prefix.length + text.length + 1;
        }
        selected.reverse();
        const sent = selected.map(({ record }) => record);
        const submitted = introduction + selected.map(({ record, prefix }) => prefix + record.text + '\n').join('');

        let observations: Observation[];
        try {
          if (!sent.length) throw new Error('说明和识人笔记过长，无法在 30000 字内附上原话。');
          mkdirSync(claudeDir, { recursive: true });
          observations = askClaude(command, values.model, claudeDir, submitted).filter(({ quote }) =>
            typeof quote === 'string' && quote.trim() && sent.some(record => record.text.includes(quote)),
          ).slice(0, 2);
        } catch (error) {
          console.log(`${key} · ${unseen.length} 句 · Claude 失败：${String(error).replace(/\s+/g, ' ')}`);
          exitCode = 1;
          continue;
        }

        const log = dryRun ? previewLog : readFileSync(logPath, 'utf8');
        const result = addObservations(log, observations, { name, records: sent }, name, last.date, localDate(now));
        added = result.added.length;
        if (added) {
          const appended = result.log.slice(log.length);
          if (dryRun) {
            previewLog = result.log;
            console.log(appended.trim());
          } else {
            appendFileSync(logPath, appended, { flag: constants.O_WRONLY | constants.O_APPEND });
          }
        }
      }
      state.sessions[key] = group.length;
      saveState();
      console.log(`${key} · ${unseen.length} 句 · 记了 ${added} 条`);
    }
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = observe();
}
