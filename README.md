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

## 六个工具（bot 自己会用）

- `relay_load` — 重读人格卡 + 交接书 + 最近记忆（失忆自救）
- `relay_remember` — 记一条长期记忆（身份、偏好、承诺、教训）
- `relay_recall` — 按关键词回忆
- `relay_handover` — 读/写交接书
- `relay_persona` — 读/更新人格卡
- `relay_status` — 记忆库状态 + 当前上下文压力

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
