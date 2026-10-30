# Changelog

## 0.2.0（2026-10-31）

记忆不再只进不出。这一版给每条记忆上了户口（来源）和生死簿（状态）。

**新功能**

- 记忆来源五档：`owner`（主人说的）> `self`（自己说过/答应的）> `evidence`（有据观察）> `tool`（工具台账）> `inferred`（推断垫底）；老数据标 `unknown`，不猜。
- 作废盖章不删行：`status: active/superseded`，作废留 `retractNote` 与 `supersededBy`，历史永久可翻案（`relay_recall` 带 `includeSuperseded: true`）。
- 同键规则替换：`relay_remember` 带 `subject` 时，同键旧记忆自动盖章作废——确定性规则，不靠模型猜。
- 新工具 `relay_retract`：按内容片段定位最近一条 active 记忆，盖章作废并记原因。
- 写入历史：`relay_handover` / `relay_persona` 覆盖前旧版自动留进 `history/`，各保留最近 10 份。
- 容量预警双保险：占用达 70% **或** 剩余不足 4 万 tokens，任一命中即提醒写交接（大窗口下比例线永远等不到的问题）。
- 跨会话档案检测：`agent/pre-step` 每 2 秒比对 persona/handover/facts 的 mtime+size 指纹，别的会话写了档，下一步之前自动提示重读；自己写档推平基线，60 秒节流防刷屏。
- 凭据拦截：`relay_remember` 写入前扫描明文凭据（`sk-`、`api_key=`、`password:`、长 token、PEM 私钥），命中拒绝写入——宁拦错，不放行。

**修复**

- facts.jsonl 首行 BOM 导致第一条记忆从未被读出的问题（读取侧 trim 兜底 + 数据侧迁移修复）。
- store 层并发写丢行（读-改-写竞争）：三个写函数同一目录串行化，基准 E08 从 n=1 修到 n=2。

**质量**

- 测试：smoke 12 + step4 26 + benchmark 48 = 86 项，全绿。
- 基准场景集 v1（50 场景）：A 同键替换 12/12、B 作废翻案 8/8、C 来源 8/8、D 凭据拦截 10/10、E 健壮性 10/10。
- 真实记忆库迁移：46 条补上 source/status，逐条校验一字不差（迁移脚本 `ai-学习/migrate-facts.mjs`，不随包分发）。

**已知边界**

- 写锁只覆盖进程内；两个 DSH 实例共用同一记忆库不被支持（README Q8）。
- store 层不自动创建目录，由工具层 `ensureStore` 保证；store 层不校验 source 枚举（校验在工具层）。

## 0.1.0（2026-10-28）

首个版本：磁盘人格卡/交接书/长期记忆（persona.md / handover.md / facts.jsonl），新会话自动读档注入，容量预警提醒写交接，6 个 relay_* 工具（load / remember / recall / handover / persona / status）。
