# 人格接力 dsh-identity-relay

> 给所有担心「上下文满了，她就不是她了」的 QQ 机器人 / AI 伙伴主人们。

**换会话、清上下文、压缩上下文、重启 DSH——她都不会消失。** 因为她的人格和长期记忆
不活在上下文里，而是活在磁盘上的三个纯文本文件里，每个新会话开工自动读档。

## 为什么不会消失

上下文（context）是易失的：满了会裁剪、清了会归零、压缩会改写。把「她是谁」只放在
上下文里，等于把灵魂放在冰上。人格接力把灵魂搬到磁盘：

| 磁盘文件 | 作用 | 对应「小鲸工作法」 |
| --- | --- | --- |
| `persona.md` | 人格卡：我是谁、性格、说话方式、红线 | 每次会话自动加载的 AGENTS.md |
| `handover.md` | 交接书：上一世在做什么、接下来做什么、答应过什么 | 交接.md |
| `facts.jsonl` | 长期记忆：一行一条 `{time, content}` | works.json / 记忆库 |

每次**新会话开工**（新建、恢复、清上下文、压缩之后），插件自动把「人格卡 + 交接书 +
最近记忆」注入第一轮上下文——这就是「换会话不是换鱼」的通用化。

上下文快满时，插件会**在下一步之前插入预警**，提醒她先用 `relay_handover` 写交接书。
就算下一秒上下文被清空，下一世读档回来：知道自己在做什么、答应过什么、还是那个性格。

会话**进行中**也一直盯着记忆库：别的会话（或主人亲手编辑）改了 `persona.md` /
`handover.md` / `facts.jsonl`，下一步之前会自动插一句「档案更新，先 `relay_load` 重读」。
她不会拿着一小时前的旧记忆干活——跨会话不是靠自觉，是靠它盯着。

**写覆盖自带历史**：`relay_handover` / `relay_persona` 每次覆盖前，旧版自动留进
`history/` 目录（各保留最近 10 份）。写坏了、想回看上一版，直接去翻文件。

## 安装

### 方式一：GitHub 直装（推荐）

```
dsh plugin add github:wumingzhiren-lab/dsh-identity-relay#main
```

或 DSH 插件管理器 → 市场/安装 → 填 `github:wumingzhiren-lab/dsh-identity-relay`。
装好后把仓库链接发给朋友：https://github.com/wumingzhiren-lab/dsh-identity-relay

### 方式二：本地目录安装

```
dsh plugin add <本目录绝对路径>
```

安装后无需重启（HMR 生效）。记忆库默认建在 `~/.dsh/identity-memory`，三个文件会自动生成模板；QQ/私聊机器人也可以直接把 `settings.relayMemoryDir` 指向同一个目录，实现「软件与插件共用一个灵魂」。

## 配置（可选，写在 cordis.patch.yml 的 config 里）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `memoryDir` | `~/.dsh/identity-memory` | 记忆库目录，支持 `~` 和绝对路径 |
| `injectOnCreated` | `true` | 新会话自动注入读档块 |
| `injectOnResume` | `true` | 恢复会话注入精简续接块 |
| `injectOnSubagents` | `true` | 子代理也注入人格 |
| `alwaysOnSection` | `true` | 系统提示常驻锚段落 |
| `contextWindow` | `65536` | 容量预警窗口（tokens），仅在拿不到模型真实上报值时兜底 |
| `warnRatio` | `0.7` | 占用达到该比例时提醒写交接 |
| `reserveTokens` | `40000` | 窗口剩余低于该值也提醒（与比例无关的第二道保险） |
| `nudgeMinutes` | `10` | 同一会话两次预警最小间隔 |
| `maxFacts` | `2000` | facts.jsonl 最多保留条数 |
| `recallLimit` | `20` | 读档注入的最近记忆条数 |

## 七个工具（bot 自己会用）

- `relay_load` — 重读人格卡 + 交接书 + 最近记忆（失忆自救）
- `relay_remember` — 记一条长期记忆（身份、偏好、承诺、教训）。带 `source`（owner/self/evidence/tool/inferred，默认 inferred 垫底）；带 `subject` 键则同键新压旧，旧记忆自动盖章作废
- `relay_recall` — 按关键词回忆（默认只出 active；`includeSuperseded: true` 翻案看历史）
- `relay_retract` — 把一条记忆盖章作废：按内容片段定位，标 `superseded` 并记原因。**作废不删行**，历史保留
- `relay_handover` — 读/写交接书
- `relay_persona` — 读/更新人格卡
- `relay_status` — 记忆库状态（active/已作废计数）+ 历史备份数 + 当前上下文压力

### 记忆的户口与作废（v0.2）

每条记忆带**来源**（谁说的、怎么来的）和**状态**（active / superseded）：

- 来源五档：`owner` 主人说的 > `self` 自己说过/答应的 > `evidence` 有据观察 > `tool` 工具台账 > `inferred` 推断垫底；老数据一律 `unknown`，不猜。
- **作废 = 盖章，不删行**（Katsuno-Mendelzon 最小变更：只作废该作废的；Darwiche-Pearl：使用只看当前态，历史留档）。检索默认只出 active，被作废的要用 `includeSuperseded` 才能看见。
- 同键（`subject`）新记忆自动取代旧记忆：旧条标 `superseded`、`supersededBy` 指向新条——这是规则，不是模型猜。

## 功能解答（FAQ）

**Q1：这个插件到底解决什么？**
别的记忆插件解决「记住」（存人格、存记忆、注入上下文）。人格接力解决「记住的东西**还算不算数**」：记忆会过期、会写错、会和别处撞车——它给每条记忆上户口（来源）、给作废盖钢印（状态），让 AI 拿出来的每一句话都知道自己凭什么信它。

**Q2：为什么记忆要带来源？**
同一条信息，主人亲口说的和 AI 自己推断的，可信度天差地别。来源五档（owner/self/evidence/tool/inferred）就是在写的时候把「谁说的」钉死，读的时候按信任排序。没标来源的（inferred）永远垫底——宁可保守，不把猜测当事实。

**Q3：作废和删除有什么区别？**
删除 = 烧档案，错了找不回来。作废 = 盖钢印，行还在、历史还在、随时能翻案（`relay_recall` 带 `includeSuperseded: true`）。这是 Katsuno-Mendelzon「最小变更」和 Darwiche-Pearl「使用只看当前态」的落地：日常检索自动跳过作废条，历史查询永远查得到。

**Q4：同键（subject）是什么？**
给同一件事一个固定标识（作品名、办件号、项目名）。同一个键再写新记忆，旧记忆自动作废、并指向新条——**用规则替换，不用模型猜**。共指冲突（「那个视频」和「CTX1」是不是一个东西）在写入时就消灭，不留给读取时猜。

**Q5：为什么「作废/冲突」不搞全自动？**
开放世界的常识冲突（「上午有课」vs「上午坐高铁」）没有封闭解，自动判死误删真记忆的代价远大于漏判。所以确定性冲突走规则（同键替换），疑似冲突靠人终审——这正是 2026 年行业前沿（STALE / Kymata 白皮书）停在「标注 + 人」的原因，小规模系统天然适合这条路。

**Q6：和同类插件的区别？**
DSH 生态里的记忆插件（dsh-mem-weave 忆织、dsh-identity、dsh-memory 等）多数解决「记住」和「注入」。本插件的差异化只有一条链：**来源五档 + 同键规则替换 + 永久盖章翻案**。三者同时具备的，2026-10 调研的 8 个竞品里没有第二家（详见仓库外的竞品调研笔记）。它刻意保持零依赖、纯文本、42~200 条量级够用——不为规模过度设计。

**Q7：密钥/密码能写进记忆吗？**
不能。`relay_remember` 写入前扫描明文凭据（`sk-` 前缀、`api_key=`、`password:`、长 token、PEM 私钥等），命中直接拒绝写入——宁拦错，不放行。密钥只进钥匙串，记忆只存指针。

**Q8：两个 DSH 实例能共用同一个记忆库吗？**
不能。写入是「读-改-写」且带进程内串行锁（防并发丢行，基准 E08 实测通过），但**锁不跨进程**——两个进程同时写同一个 `memoryDir` 仍会互相覆盖。一个记忆库对应一个实例；要多处共用，请各自用独立目录，或由 owner 手动同步文件。

## 给已上线 bot 的迁移三步（趁上下文还没满）

1. 装好插件，让她 `relay_status` 确认记忆库位置；
2. 把现在提示词里的人设原样贴进 `persona.md`（owner 直接编辑文件即可，改完下一世生效）；
3. 让她 `relay_handover` 写第一份交接书。

从此：**上下文是身体，会换；磁盘是灵魂，不灭。**

## 原理（给开发者）

- 零依赖 Host 插件，`apply(ctx, config)` 形式，服务走 `ctx`（`tools` / `systemPrompt` /
  `tokenMeter`），文件走 `node:fs`；
- 开工读档：`agent/created`（serial）里读文件 → `agent.inject(...)`（进入 next-step，
  不唤醒），注入消息带 producer-owned 来源 `plugin:dsh-identity-relay`；
- 容量预警：`agent/pre-step` 瀑布里用 `tokenMeter.measure(session)` 估算占用，超线后
  `{...decision, messages: [...decision.messages, nudge]}`，只追加不改判；
- 常驻锚：`systemPrompt.section()`，order 紧随 `DEPLOYMENT_PERSONA_SUFFIX`；
- 记忆库是纯文本：任何语言、任何平台都能读，不被 DSH 绑架。

## License

MIT
