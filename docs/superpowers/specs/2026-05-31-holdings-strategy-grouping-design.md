# Holdings 期权策略组合(P2)— 设计文档

- **日期**:2026-05-31
- **状态**:设计已批准,待写实现计划
- **目标端**:仅自托管 Web 版(`apps/server` + 浏览器前端,`BUILD_TARGET=web`);新增后端须同时在 `apps/tauri` 注册命令以通过 adapter 平价测试,但不针对桌面端做 UI。
- **依赖**:P1(按标的归组,已合并 `main`)。本阶段在 P1 之上增加一层。
- **关系**:P1 = 按标的归组(纯前端);**P2 = 命名策略组合(本文档)**;P3 = 完整 Greeks + 可配置列(独立,后做)。

---

## 1. 目标与非目标

### 目标
1. 在「按标的」分组下,把每个标的的期权腿**自动识别**成策略子组,呈现为**两级嵌套**:标的 → 策略 → 腿。
2. 全面识别策略类型:垂直、日历、对角、跨式、宽跨、备兑看涨、保护性看跌、领口、蝶式、铁鹰、铁蝶。
3. 用户可对策略组**改名 / 取消分组 / 手动建组**,改动**持久化**(覆盖层)。
4. 每个策略组显示**组合合计盈亏**(base 货币)与**净 debit/credit**。
5. 三视图(桌面表 / 移动卡片 / 仪表盘部件)保持一致。

### 非目标
- 不做跨标的、跨账户的组合(策略 = 单标的 + 单账户)。
- 不从 IBKR 真正"导入" combo(当前 `tools/ibkr-sync` 不带 combo 分组)。预留接口,将来可接。
- 不做独立的 merge/split 原语(合并/拆分 = 取消分组后重建)。
- 不涉及 Greeks(P3)。

---

## 2. 核心决策(已与用户确认)

| # | 决策 | 选定 |
|---|---|---|
| 1 | 组合模型 | **混合**:自动识别 + 用户确认/编辑 |
| 2 | 层级结构 | **两级嵌套**:标的 → 策略 → 腿 |
| 3 | v1 识别范围 | **全面**:2 腿 + 股票类 + 3-4 腿结构 |
| 4 | 持久化模型 | **覆盖层**:自动识别实时跑(不存),后端只存用户改动 |
| 5 | 编辑 UX | `⋯` 菜单(改名 / 取消分组)+ 散腿勾选建组 |
| 6 | 副开关 | 加「策略子分组」开关,默认开;关掉回 P1 平铺腿 |
| 7 | 覆盖表腿成员存储 | JSON TEXT 数组 |

---

## 3. 架构总览

```
                            ┌───────────────────────────────────────┐
   后端(最小,只存覆盖)    │ option_strategy_override 表 (diesel)   │
                            │ core::option_strategy service+trait    │
                            │ tauri 命令 ⟷ server Axum 路由(双surface)│
                            └───────────────────────────────────────┘
                                          ▲  CRUD(react-query)
                                          │
   前端(检测 + 渲染,纯逻辑) ┌──────────────────────────────────────┐
                            │ detect-strategies.ts (纯函数,可测)     │
                            │   输入: 某标的 Holding[] + 覆盖记录[]   │
                            │   输出: { strategies[], looseLegs[] }   │
                            │ group-by-underlying.ts (扩展两级)        │
                            │ 三视图渲染 (DataTable 递归 / 手写卡片)   │
                            └──────────────────────────────────────┘
```

**职责分离**:检测算法是纯前端逻辑(复用 P1 的 `parseOccSymbol`,无后端往返);后端只持久化"用户覆盖",保持最小。

---

## 4. 数据模型

### 4.1 前端行联合(扩展 P1)

P1 已有:`HoldingRow = HoldingGroupRow | Holding`,判别符 `kind`。
P2 扩展为三种 + 新增策略组:

```ts
// 标的组(P1 的 HoldingGroupRow,kind:'group')——subRows 类型变化:
interface UnderlyingGroupRow {
  kind: 'group';
  // ...P1 现有字段不变(underlyingKey/Symbol/Name、各 base 聚合、memberCount…)
  subRows: (StrategyGroupRow | Holding)[];   // ← 原为 Holding[]
}

// 策略组(新):一组腿 + 组合聚合,本质同 HoldingGroupRow 的聚合原语
interface StrategyGroupRow {
  kind: 'strategy';
  id: string;                 // `strategy:${underlyingKey}:${legKey}`,legKey = 腿 OCC 符号排序后 join('|')
  underlyingKey: string;
  strategyType: StrategyType; // 检测出的类型,或用户覆盖
  name: string;               // 显示名:用户自定义 > strategyType 的默认标签
  source: 'auto' | 'override';// 自动识别 vs 用户保存
  overrideId?: string;        // 当 source==='override'
  memberCount: number;
  // base 货币聚合(复用 P1 算法):
  marketValueBase, costBasisBase, totalGainBase, totalGainPct,
  dayChangeBase, dayChangePct, weight: number;
  netCashBase: number;        // = Σ costBasisBase;>0 净付(debit)/ <0 净收(credit)
  baseCurrency: string;
  subRows: Holding[];         // 腿
}

type StrategyType =
  | 'vertical'      // 垂直价差(再细分方向见下)
  | 'calendar'      // 日历/水平
  | 'diagonal'      // 对角
  | 'straddle'      // 跨式
  | 'strangle'      // 宽跨
  | 'covered-call'  // 备兑看涨
  | 'protective-put'// 保护性看跌
  | 'collar'        // 领口
  | 'butterfly'     // 蝶式
  | 'iron-condor'   // 铁鹰
  | 'iron-butterfly'// 铁蝶
  | 'custom';       // 用户手动建组、无法归类

// 守卫(与 P1 风格一致):
isUnderlyingGroupRow(r): r.kind === 'group'
isStrategyGroupRow(r):   r.kind === 'strategy'
// 叶子 Holding 无 kind。
```

`name` 的默认标签由 `strategyType`(+ 方向)生成。**默认标签为英文**(应用 UI 为英文),由 `detect-strategies.ts` 中的 `defaultStrategyLabel(type)` 提供。垂直价差方向敏感(规则:多低 strike = Bull,多高 strike = Bear;类型取自腿的 optionType),例如 `vertical` + 多腿在低 strike 的 call → "Bull Call Spread"。规范映射表如下:

| strategyType | 默认标签 |
|---|---|
| vertical | 方向敏感:Bull Call Spread / Bear Call Spread / Bull Put Spread / Bear Put Spread |
| calendar | Calendar Spread |
| diagonal | Diagonal Spread |
| straddle | Straddle |
| strangle | Strangle |
| covered-call | Covered Call |
| protective-put | Protective Put |
| collar | Collar |
| butterfly | Butterfly |
| iron-condor | Iron Condor |
| iron-butterfly | Iron Butterfly |
| custom | Custom Strategy |

### 4.2 后端覆盖记录

```ts
// 前端类型(与 Rust camelCase 序列化一致)
interface StrategyOverride {
  id: string;
  accountId: string;
  underlying: string;            // 标的符号(OCC 解析得到)
  name: string | null;           // 用户自定义名;null → 用 strategyType 默认标签
  strategyType: StrategyType | null; // 创建时记录的类型,或用户覆盖
  legs: string[];                // 腿的 OCC 符号(含股票腿用裸符号)
  mode: 'group' | 'exclude';     // group=显式成组;exclude=强制留散腿
  createdAt: string;
  updatedAt: string;
}
```

**Diesel 迁移**(参考 `2026-05-19-000001_lots_and_snapshot_positions`):新建
`crates/storage-sqlite/migrations/2026-05-31-000001_option_strategy_overrides/{up.sql,down.sql}`:

```sql
CREATE TABLE option_strategy_overrides (
  id           TEXT PRIMARY KEY NOT NULL,
  account_id   TEXT NOT NULL,
  underlying   TEXT NOT NULL,
  name         TEXT,
  strategy_type TEXT,
  legs         TEXT NOT NULL,    -- JSON 数组
  mode         TEXT NOT NULL,    -- 'group' | 'exclude'
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_option_strategy_overrides_account ON option_strategy_overrides(account_id);
```
`down.sql`:`DROP INDEX` + `DROP TABLE`(逆序)。schema.rs 同步(`diesel print-schema` 或手写 `table!`)。

**core 模块** `crates/core/src/option_strategy/{mod.rs,model.rs,service.rs}`:domain model
+ `OptionStrategyRepository` trait(`list_for_accounts/create/update/delete`)+ `OptionStrategyService`。
存储实现放 `crates/storage-sqlite/src/option_strategy.rs`(Diesel 记录结构,`#[derive(Queryable,Selectable,Insertable)]`,写经 `WriteHandle`),并在 `storage-sqlite/src/lib.rs` 声明模块。

---

## 5. 检测算法(`detect-strategies.ts`,纯函数,TDD)

### 5.1 输入/输出
```ts
function detectStrategies(
  legs: Holding[],            // 单一标的下的全部持仓(期权腿 + 可能的正股)
  overrides: StrategyOverride[], // 该标的、该账户的覆盖记录
): { strategies: StrategyGroupRow[]; looseLegs: Holding[] }
```

### 5.2 腿特征提取
对每条 Holding:
- 期权腿:`parseOccSymbol(symbol)` → `{ underlying, expiration, optionType: 'CALL'|'PUT', strikePrice }`。
- 多空:`quantity > 0` 多 / `< 0` 空;`|quantity|` = 合约数。
- 股票腿:非期权且 `symbol === underlying`;`quantity` 为股数。
- 合约乘数取 `Holding.contractMultiplier ?? 100`(股票=1)。

### 5.3 流程
1. **先应用覆盖**:
   - `mode='group'` 记录:按 `accountId + OCC 符号` 在 `legs` 里重匹配其 `legs[]`。命中的腿移出待检测池,组装成 `StrategyGroupRow{source:'override'}`,显示名用 `name ?? 默认标签(strategyType)`。当前开腿数 `< 2` 的记录 → **隐藏**(视为失效;v1 不弹清理,留作后续)。
   - `mode='exclude'` 记录:命中的腿移出池,直接进 `looseLegs`。
2. **自动识别剩余池**:按"最具体→最简单"顺序贪心,每条腿至多归一个策略:
   1. 铁鹰 / 铁蝶(4 腿)
   2. 蝶式(3 腿)
   3. 领口(股票 + 2 腿)
   4. 垂直 / 日历 / 对角 / 跨式 / 宽跨(2 腿)
   5. 备兑看涨 / 保护性看跌(股票 + 1 腿)
3. 未被任何策略消费的腿 → `looseLegs`。

### 5.4 模式判定(同标的内)

| 策略 | 腿构成(同标的) | 判定 |
|---|---|---|
| 垂直价差 | 2 期权,同类型(均 C 或均 P)、**同到期**、不同 strike、一多一空 | 方向规则对 call/put 统一:**多低 strike 腿 = 牛市**,**多高 strike 腿 = 熊市**;标签例:牛市看涨价差(call+多低)、熊市看跌价差(put+多高) |
| 日历(水平) | 2 期权,同类型、**同 strike**、不同到期、一多一空 | — |
| 对角 | 2 期权,同类型、不同 strike **且**不同到期、一多一空 | — |
| 跨式 | 1 C + 1 P,**同 strike、同到期**、同向(均多或均空) | — |
| 宽跨 | 1 C + 1 P,不同 strike、**同到期**、同向 | — |
| 备兑看涨 | 多股票 + 空 call;股数 ≥ 100 × 空 call 合约数 | — |
| 保护性看跌 | 多股票 + 多 put | — |
| 领口 | 多股票 + 空 call(高 strike)+ 多 put(低 strike) | — |
| 蝶式 | 3 期权,同类型、同到期、strike 等距 K1<K2<K3、数量比 1:2:1(全多或全空中间反向) | call 蝶 / put 蝶 |
| 铁鹰 | 4 期权同到期:多 put(最低)+ 空 put + 空 call + 多 call(最高),put strikes < call strikes | 通常净收 |
| 铁蝶 | 同铁鹰,但空 put 与空 call 同一中间 strike | — |

**歧义与保守性**:仅在腿集**无歧义匹配**某模式时才成组;数量比不符(如蝶式非 1:2:1)、腿集部分匹配、或同组腿能多解时——**留散腿**,交用户手动建组。单条空 put(现金担保看跌)、单条腿不成组。

### 5.5 `group-by-underlying.ts` 扩展
`buildGroupRow` 内:当该标的含期权腿且"策略子分组"开关开时,调用 `detectStrategies`,将 `subRows` 置为 `[...strategies, ...looseLegs]`(策略在前、散腿在后);关时维持 P1 的平铺腿。标的组的 base 聚合仍对**全部腿**求和(不变)。

---

## 6. 持久化与生命周期(覆盖层)

- 后端只存 `StrategyOverride` 记录;自动识别结果**不入库**,每次渲染实时算。
- **改名自动组** = 新建一条 `mode='group'` 记录,`legs` = 该自动组的腿,`name` = 自定义名。
- **手动建组**(散腿)= `mode='group'`,`legs` = 用户勾选的腿。
- **取消分组**(对自动组)= 新建 `mode='exclude'`,`legs` = 这些腿(强制留散)。
- **重命名/编辑已存组** = `update` 该记录。
- 每次同步后按 `accountId + OCC` 重匹配:平仓腿(不在 holdings 内)自动脱离;组 `< 2` 腿自动隐藏;**新腿不自动并入已存组**,走新一轮自动识别。
- **预留扩展**:将来 sync 若带 broker combo id,可加 `source_combo_id` 字段作最高优先的成组来源,与用户覆盖、自动识别三层叠加。

### 6.1 双 surface CRUD(照 `custom_providers` 模板)

| 命令名(invoke 契约) | HTTP | 说明 |
|---|---|---|
| `get_option_strategy_overrides` | GET `/option-strategy-overrides?accountId=` 或 POST `/query` | 按账户/scope 列出 |
| `create_option_strategy_override` | POST `/option-strategy-overrides` | |
| `update_option_strategy_override` | PUT `/option-strategy-overrides/{id}` | |
| `delete_option_strategy_override` | DELETE `/option-strategy-overrides/{id}` → 204 | |

- 前端 `adapters/shared/option-strategy.ts`(`invoke` + `logger`);在 `adapters/web/core.ts` 的 `COMMANDS` map + switch 里登记四条;`adapters/{tauri,web}/index.ts` 各自再导出。
- `apps/tauri/src/commands/option_strategy.rs` + `lib.rs` `generate_handler!` 注册;`apps/server/src/api/option_strategy.rs` `router()` + `api.rs` `.merge()`。
- 服务注入 `AppState`(server `main_lib.rs`)与 `ServiceContext`(tauri `registry.rs`+`providers.rs`)。
- **必过** `adapter-command-parity.test.ts`(命令名两端一致)。
- react-query hook `hooks/use-option-strategies.ts`:`useQuery` 列表 + `useMutation` 增改删,`onSuccess` invalidate `[QueryKeys.OPTION_STRATEGIES]`;`query-keys.ts` 加键。

---

## 7. 组合盈亏

- 复用 P1 base 货币聚合:`marketValueBase/costBasisBase/totalGainBase/dayChangeBase` 对组内腿求和;`totalGainPct = totalGainBase / |costBasisBase|`、`dayChangePct = dayChangeBase / |prevCloseSum|`,分母为 0 取 null。
- **净 debit/credit**:`netCashBase = Σ costBasisBase`;`>0` 显示"净付 $X"(debit),`<0` 显示"净收 $X"(credit)。
- 短腿(负 quantity)自然以负值入和。

---

## 8. UI(三视图)

### 8.1 桌面表 `holdings-table.tsx`
- `Flat / 按标的` 开关不变;新增**「策略子分组」副开关**(`usePersistentState`,key `holdings-table:group-by-strategy`,默认 true),仅在「按标的」时可用。
- `DataTable` 传 `getSubRows` 递归返回下一级:标的组 → `(策略组|散腿)[]`;策略组 → `Holding[]`;腿 → undefined。`row.depth` 控制缩进(已就绪)。
- 各列 cell/accessor/sortingFn 增加 `isStrategyGroupRow` 分支:策略行显示展开 chevron + 策略名 + 腿数 Badge + 组合 `AmountDisplay`/`GainPercent` + 净 debit/credit。
- 策略行右侧 `⋯` 菜单(shadcn `DropdownMenu`):**改名**(弹小 dialog/inline)、**取消分组**。
- **散腿勾选建组**:轻量选择模式——某标的下出现「选择」入口,勾选腿后「建为策略」→ 自动建议 `strategyType` 默认名(可改)→ 调 `create`。

### 8.2 移动卡片 `holdings-table-mobile.tsx` / 仪表盘 `top-holdings.tsx`
- 手写卡片同样加一层缩进块(策略组 `ml-4 border-l`,腿再缩进)。
- 移动端「策略子分组」开关放 `holdings-mobile-filter-sheet.tsx`;仪表盘放其 `Popover` options 菜单。
- **v1 编辑操作(改名/取消分组/建组)仅桌面表提供;移动卡片与仪表盘部件为只读展示**(显示策略名 + 组合盈亏 + 腿),编辑入口后续阶段再补。

---

## 9. 边界与边缘情况
- 策略 = 单标的、单账户;聚合(全账户)视图下各账户的组各自挂在标的下,允许同名多组。
- 多货币:一律 base 聚合(同 P1)。
- closed/expired 腿不在 holdings 内,自然排除;覆盖记录重匹配时随之脱离。
- 同一标的多个相同类型策略(如两个垂直价差)→ 各自成组,`id` 用稳定腿键区分。
- 合约乘数:聚合沿用 Holding 已含乘数的 base 值;检测中乘数仅用于备兑/领口的股数覆盖比与展示。

---

## 10. 测试策略(TDD)
- **`detect-strategies.test.ts`**(纯单元,重点):每种策略的正例;歧义/部分匹配 → 散腿;覆盖 `group`/`exclude` 优先于自动;平仓腿脱离;组 `<2` 隐藏;贪心顺序(铁鹰优先于其内含的垂直);单空 put 不成组。用最小 `makeHolding` 工厂。
- **`group-by-underlying` 两级嵌套测试**:策略子分组开/关;subRows = 策略 + 散腿;标的聚合不变。
- **DataTable 多级展开**:扩 `data-table-expansion.test.tsx` 覆盖 depth≥2 递归展开。
- **后端**:`option_strategy` service/repo 单测(CRUD、按账户过滤、JSON legs 序列化);`adapter-command-parity.test.ts` 通过。
- **三视图组件测试**:策略行渲染、`⋯` 改名/取消分组、勾选建组、移动/仪表盘嵌套。
- 命令:`pnpm --filter frontend test`、`pnpm type-check`、`pnpm lint`、`cargo test`(core + storage-sqlite)。

---

## 11. 涉及文件清单(预估)

**新增**
- `apps/frontend/src/pages/holdings/utils/detect-strategies.ts` + `.test.ts`
- `apps/frontend/src/adapters/shared/option-strategy.ts`
- `apps/frontend/src/hooks/use-option-strategies.ts`
- `crates/core/src/option_strategy/{mod.rs,model.rs,service.rs}`
- `crates/storage-sqlite/src/option_strategy.rs`
- `crates/storage-sqlite/migrations/2026-05-31-000001_option_strategy_overrides/{up.sql,down.sql}`
- `apps/tauri/src/commands/option_strategy.rs`
- `apps/server/src/api/option_strategy.rs`

**修改**
- `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts`(+测试)
- 三视图:`holdings-table.tsx`、`holdings-table-mobile.tsx`、`holdings-mobile-filter-sheet.tsx`、`top-holdings.tsx`
- `packages/ui/.../data-table/index.tsx`(确认递归 getSubRows;P1 多已支持)
- `apps/frontend/src/lib/types.ts`(StrategyGroupRow、StrategyOverride、StrategyType)
- `apps/frontend/src/lib/query-keys.ts`
- `apps/frontend/src/adapters/web/core.ts`(COMMANDS + switch)、`adapters/{tauri,web}/index.ts`
- `crates/storage-sqlite/src/{schema.rs,lib.rs}`、`apps/tauri/src/{lib.rs,commands/mod.rs,context/registry.rs,context/providers.rs}`、`apps/server/src/{api.rs,main_lib.rs}`

---

## 12. 实施顺序建议(留给 plan 细化)
1. 后端覆盖表 + core service + 双 surface CRUD + parity(可先不接 UI)。
2. `detect-strategies.ts`:先 2 腿(垂直/日历/对角/跨式/宽跨)→ 股票类(备兑/保护/领口)→ 3-4 腿(蝶/铁鹰/铁蝶),每步 TDD。
3. `group-by-underlying.ts` 两级嵌套 + DataTable 递归。
4. 桌面表渲染 + 副开关 + 覆盖层接线(改名/取消分组/建组)。
5. 移动卡片 + 仪表盘嵌套。
6. 全量测试 + type-check + lint + cargo test。
