# 识人笔记 identity-note

一份纯文本的电子身份。Claude Code、Codex、Antigravity 读了它，就知道你懂什么、是什么样的人、该怎么跟你说话。

> **In English.** *identity-note* is a skill that keeps a plain-text profile of one person that any AI coding assistant can read: skill level per domain, personality and "if this, then that" habits, and what the AI should quietly cover for. Every judgment points to the person's own words, a script checks each quote against the local chat logs, and a timer keeps adding new evidence from Claude Code, Codex and Antigravity sessions. The skill and the notes are written in Chinese.

## 一个老问题

你在 Claude Code 里说过三遍：前端你熟，数据库你不熟。换到 Codex，它又拿你当数据库老手，一上来就是一串术语。回到 Claude，它倒是记下了“用户是前端开发”，可等你问起数据库，它照样只甩给你三个术语。

每家 AI 都在记你，各记各的，格式不同，彼此看不见。记下来的多是规矩和事实：你用什么语言，项目放在哪个目录。很少有谁记下这些：你在哪一行是专家、在哪一行还是新手；你说“挺好的”，有时只是客气，心里还想再改；你问“这个能不能快一点”，其实是在问要不要换个做法。

一次对话顺不顺，往往就看这些。

## 从哪来

识人笔记是从一个叫“碳硅接口”的项目里拆出来的，那个项目还没有公开。默认的文件夹 `~/.local/share/sic/` 里的 `sic` 就是它：硅（Si）和碳（C），模型和人。

那个项目把干活极强的写代码模型叫“神”：事情讲清楚了，它执行力超强，可它说话默认你是专家。旁边有一个说人话的 AI 叫“巫”，负责摸清人懂多少，在人和神之间传话。

做着做着发现，巫最有用的本事是认识这个人，会翻译倒在其次。认识一个人的结果应该谁都能读，不该锁在某一家 AI 的记忆里。于是有了识人笔记。

## 它长什么样

一个人一个文件夹，三份 Markdown：

```
identity/
├── me.md      识人笔记本身，AI 先读这一份
├── log.md     见闻，就是证据，一条一条往后加
└── words.md   这个人懂哪些词
```

`me.md` 看人看两条线：

- **知识和水平**，按领域分开评，用德雷福斯技能五级：新手、进阶新手、胜任、精通、专家。同一个人可以这一行是专家、那一行是新手。对新手要讲步骤、讲道理；对专家讲多了反而碍事，心理学里叫专长逆转效应。
- **性格和风格**。性格用大五人格，只当参考；风格写成一条条“如果……就……”：遇到什么情况，这个人会怎样；这个人说某种话时，意思其实是什么。

再往下是两块别处少见的：

- **要悄悄补的地方。** 模型比人强，所以由模型顺着人的水平和风格说话；但人的坏习惯不跟着做，在人看不见的地方悄悄补上。悄悄补的只能是不用人拍板的事。删东西、花钱、对外发出去，还有人必须知道的风险，照样用一句话说出来，不然“悄悄”就成了瞒着人。
- **跟这个人说话。** 从上面推出来的几条具体做法，包括哪些事可以替人定，哪些要摆给人看、让人定。

下面是一段编出来的例子，人物是虚构的：

```markdown
| 领域 | 水平 | 怎么看出来的 |
|---|---|---|
| 用户研究 | 专家 | 能指出访谈提纲里哪一问在诱导回答 [4][11] |
| Git 和版本管理 | 新手 | 问过“提交和保存有什么区别” [6][15] |

- 如果 TA 发来一张截图，什么也不说，就是要你看图里圈出来的地方。[3][9]
- 如果 TA 说“先这样”，是暂时接受，过两天多半还会回来改。[7][12]

| TA 的短处 | 你悄悄做什么 |
|---|---|
| 一次改很多处，改完记不清改了什么 [8][13] | 每处改动分开保存，想撤回哪一处都行 |
```

完整的模板在 [`templates/`](templates/)，写法的标准在 [SKILL.md](SKILL.md)。

## 为什么能信它

给人画像，最怕 AI 自己编。识人笔记有几条硬规矩：

1. **每条判断都指回证据。** 判断后面的 [编号] 指向 `log.md`，那里抄的是人当时亲手打的原话，一个字不改。
2. **原话由程序核对。** [`scripts/verify-log.ts`](scripts/verify-log.ts) 把每段原话拿到本机各家 AI 的对话记录里逐字去找。只算人自己打的话；AI 说的、工具的输出、程序在后台启动的会话，都不算。找到了，就写上出自哪次对话。
3. **一条判断至少要两次不同对话的证据。** 只在一次对话里见过的，标“证据不足”，只当线索。
4. **分清人认可过的和猜的。** 人点过头的标“已认可”，其余都是猜测。
5. **错了改判断，不改证据。** 新证据和旧判断对不上，先怀疑旧判断。原话一个字不改；当时理解错了，就在那条下面加一行更正。

第 2、3 条是跟 Emulo 学的，它是另一个从本机对话记录里提炼“你是谁”的开源项目。

## 它会自己长

笔记写出来不难，难的是一直维护。我们试过让 AI 在对话里顺手记：装上笔记以后，有四个会话读到了它，没有一个往里记过一条。

所以有了 [`scripts/observe.ts`](scripts/observe.ts)。它由定时器每 20 分钟叫醒一次，找出 Claude Code、Codex、Antigravity 里已经停了 30 分钟的对话，把人在里面新打的话连同 `me.md` 交给 Claude，挑出值得记的。它很克制：

- 只记三种：笔记里还没有的；和某条判断对不上的；给标了“证据不足”的判断再添一个例子。
- 一次对话最多记两条。人一共只说了一两句的对话直接跳过，不调 Claude。
- 原话必须一字不差地出自交给 Claude 的那几句，和已有的见闻重复就不记。

装好的第一天，它就找出了笔记里写错的一处：笔记说这个人在某一行是新手，对话里 TA 却说得很在行。

它不会自己改 `me.md`。见闻攒多了，让 AI 照 [SKILL.md](SKILL.md) 里的“一直维护”回头改判断，你看过再定。

## 和各家自带的记忆比

| | 各家 AI 自带的记忆 | 识人笔记 |
|---|---|---|
| 记什么 | 多是事实、偏好和做事的规矩 | 按领域的水平、性格、话外之意、该悄悄补什么 |
| 存在哪 | 各家一份，彼此看不见 | 本机一个文件夹，三家都读 |
| 证据 | 一般不给出处 | 每条判断指回原话，原话由程序核对 |
| 谁说了算 | AI 自己记、自己用 | 分“已认可”和“猜测”，人点了头才算数 |

## 先说清楚的几件事

- **还没有证明它让 AI 做得更好。** 我们拿新旧两版笔记做过一次盲测，结果打平；查到的同类产品，也没有一家拿出第三方的证据。它现在是一套讲得通的做法，还不是测出来的结论。
- 大五人格是从文字里猜的，准度只有中等，所以只当参考。
- 东西都在你本机：笔记是本机的文件，核对读的是本机的对话记录。只有“自动记见闻”会把你在一次对话里打的话交给 Claude，花的是你自己的 Claude 额度。你在对话里发过的密码也会交给 Claude 看；说明里要求它不摘这类内容，程序也只写原话核对得上的几句。
- Antigravity 的命令行版不读：它常被程序在后台调用，记录里分不出哪些是人开的。
- 只在 Linux 上测过。定时器的例子用的是 systemd；macOS 要自己换成 launchd。
- skill 和笔记都是中文写的。

## 装

需要 Node 22.18 或更新的版本，它自带 TypeScript 支持，不用装任何依赖。要自动记见闻，还要装好并登录 Claude Code 的命令行。

1. 把这个仓库放进三家的 skill 文件夹：

   ```bash
   git clone https://github.com/yuy227211-collab/identity-note ~/.claude/skills/identity-note
   mkdir -p ~/.codex/skills ~/.gemini/config/skills
   cp -r ~/.claude/skills/identity-note ~/.codex/skills/
   cp -r ~/.claude/skills/identity-note ~/.gemini/config/skills/
   ```

2. 在任意一家里说：“用 identity-note 给我建一份识人笔记。”它会先问你同意它读哪些资料，再从你过去亲手打的话里抄见闻、推判断，全部标成猜测，拿给你看。你点了头的才标“已认可”。
3. 让它把笔记接到三家的全局说明里。Claude Code 能直接导入 `me.md`；Codex 和 Antigravity 不支持导入，要把全文复制进去。见 [SKILL.md](SKILL.md) 的“接到各家 AI”。
4. 想让笔记自己长，就装上定时器，见 [SKILL.md](SKILL.md) 的“自动记见闻”。

随时可以核对一遍原话：

```bash
node ~/.claude/skills/identity-note/scripts/verify-log.ts --mark
```

## 文件

| 路径 | 是什么 |
|---|---|
| [SKILL.md](SKILL.md) | 给 AI 读的完整标准：怎么读、怎么建、怎么一直维护 |
| [templates/](templates/) | `me.md`、`log.md`、`words.md` 的模板，和接到全局说明里的引导语 |
| [scripts/verify-log.ts](scripts/verify-log.ts) | 核对原话，数每条判断有几次对话的证据 |
| [scripts/observe.ts](scripts/observe.ts) | 定时从对话记录里挑见闻 |
| [scripts/observe-prompt.md](scripts/observe-prompt.md) | 挑见闻时交给 Claude 的说明 |
| [tests/](tests/) | 测试，运行 `node --test` |

## 许可证

[MIT](LICENSE)
