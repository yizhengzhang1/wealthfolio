# 持仓页期权组合展示 — 设计文档

- 日期: 2026-05-31
- 状态: P1 设计已确认,待实现
- 适用构建: 仅自托管 Web 版 (`BUILD_TARGET=web`,前端经 HTTP 访问 `apps/server`)

## 1. 背景与目标

当前 Holdings 页面把每个持仓(含期权合约)作为独立的扁平行展示。参考券商 Futu 的「期权组合」形态,希望:把同一标的的正股与期权腿归到一起展示,并支持把多腿识别为命名策略组合,以及展示期权 Greeks。

这是一个横跨多个子系统的较大需求,按渐进交付拆成三个独立子项目,依次推进,每个子项目各自走「设计 → 计划 → 实现」:

| 阶段 | 内容 | 规模/风险 | 依赖 |
|---|---|---|---|
| **P1** (本文档) | 按**标的**自动归组 + 可折叠父行 + 合计市值/成本/盈亏 | 小,纯前端,无持久化 | 无 |
| **P2** | **命名策略组合**:自动识别策略类型(垂直/日历/对角/跨式…)、可改名、持久化、组合合计盈亏 | 中,新表 + 后端 + 确认/改名 UI | P1 |
| **P3** | **完整 Greeks + 可配置列设置** | 大,依赖数据源选型 | 独立 |

本文档只定义并约束 **P1**。P2/P3 仅作上下文记录,不在本次实现范围。

### P3 数据源调研结论(存档,P3 再定稿)

| 路径 | Greeks/IV | 付费 | 工作量落点 | 注意 |
|---|---|---|---|---|
| ① IBKR 直接取 | Δ/Γ/Θ/V + IV(无 ρ),服务器端算好、与 TWS 一致 | 实时需行情订阅;延迟数据 tick #83 也带 greeks+IV,免订阅 | 改 ibkr-sync,让 MCP 多取 snapshot greeks 字段 (7308/9/10/11、7633) | `ib_async` 的 `OptionComputation` 本就含这些字段 |
| ② Alpha Vantage(已集成) | `require_greeks=true` 返回 Δ/Γ/Θ/V/ρ + IV | `REALTIME_OPTIONS` 付费;`HISTORICAL_OPTIONS` 免费档可取(25 req/天) | 扩展现有 provider 解析 greeks 字段 | 代码改动最小 |
| ③ 本地 BS + 反解 IV | 自算全套 | 零外部费用 | 加 Rust crate `black_scholes`(MIT/纯 Rust)+ 接无风险利率/股息率 | 美式个股期权与券商 model greeks 有系统性偏差 |

倾向:①为主(IBKR 最权威、延迟数据免订阅)、②兜底。P3 时锁定。

## 2. P1 范围

### 2.1 In scope
- 桌面 Holdings 表(`holdings-table.tsx`,Investments 标签页)新增「按标的归组」模式。
- 把同一标的(underlying)的正股 + 所有期权腿,聚合成一个可展开/折叠的父行;父行展示合计指标。
- 顶部新增「按标的归组」开关(默认开,可关闭回到扁平表)。
- 开关状态与各组折叠状态持久化到 localStorage。

### 2.2 Out of scope (P1)
- 命名策略组合、策略类型识别、组合持久化(→ P2)。
- 任何 Greeks / IV / 列配置(→ P3)。
- 后端(`apps/server` / `crates/core`)改动、DB 迁移、新的 IPC/HTTP 端点 —— P1 完全在前端完成。
- ~~移动端表(`holdings-table-mobile.tsx`)—— 目标仅 Web 桌面浏览器,本次不动。~~ **(后续增量已纳入:用户要求手机浏览器也看到同样效果)** 移动端为卡片列表,做法:复用 `group-by-underlying.ts`,同标的 ≥2 折叠成可展开父卡片(净合计用 base 货币),**默认折叠**;在 `holdings-mobile-filter-sheet.tsx` 加 Grouped/Flat 开关(默认 Grouped);折叠/开关状态持久化(`holdings-mobile:expanded` / `holdings-mobile:group-by-underlying`)。
- Tauri 桌面端专属适配 —— 前端代码共享,改动对两端均生效,但不为 Tauri 做额外工作;不引入会破坏 Tauri 构建的依赖(P1 无新后端命令,故无此风险)。

## 3. 数据模型(仅前端)

输入:`useHoldings(scope)` 返回的 `Holding[]`(类型见 `apps/frontend/src/lib/types.ts`)。

### 3.1 underlying 归组键
对每个 `Holding` 计算 `underlyingKey: string`:
- 期权:`parseOccSymbol(holding.instrument.symbol)` 成功 → `parsed.underlying`(复用 `apps/frontend/src/lib/occ-symbol.ts`)。
- 其它(正股 / ETF / crypto / bond 等):`underlyingKey = holding.instrument.symbol`(无 instrument 的现金类持仓在 Investments 页已被过滤,不参与)。

### 3.2 行模型(联合类型)
```ts
// 新增类型(建议放 holdings 页 types 或 group-by-underlying.ts)
interface HoldingGroupRow {
  kind: 'group';
  id: string;                        // `group:${underlyingKey}`,作 React key / 稳定标识
  underlyingKey: string;
  underlyingSymbol: string;          // = underlyingKey
  underlyingName: string | null;     // 取组内正股名,否则 null(展示用 underlyingKey)
  memberCount: number;               // 子项数量,用于 (n) 徽标
  underlyingPrice: number | null;    // 组内正股现价,无正股则 null
  baseCurrency: string;
  // 合计(均为 base 货币)
  marketValueBase: number;
  costBasisBase: number;
  totalGainBase: number;             // 对应 performance 列「Unrealized Gain」(showTotalReturn)
  totalGainPct: number | null;
  dayChangeBase: number;             // 对应 performance 列「Day Change」
  dayChangePct: number | null;
  weight: number;
  subRows: Holding[];
}

type HoldingRow = HoldingGroupRow | Holding;  // 顶层行可为分组或单条持仓

// 判别器:Holding 无 kind 字段
function isHoldingGroupRow(row: HoldingRow): row is HoldingGroupRow {
  return (row as HoldingGroupRow).kind === 'group';
}
```
> 说明:performance 列在现表中用 `totalGain`/`dayChange`(随 Total/Daily 开关),故组合计同样按 `totalGain`/`dayChange`,而非 `unrealizedGain`。

### 3.3 归组算法 `groupHoldingsByUnderlying(holdings, opts)`
纯函数,新增于 `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts`:
1. 计算每个 holding 的 `underlyingKey`,按键分桶。
2. 对每个桶:
   - 成员数 == 1 → 该 `Holding` 作为顶层行(平铺,不建父)。
   - 成员数 >= 2 → 建 `HoldingGroupRow`,`subRows` = 该桶成员;计算合计(见 3.4);`underlyingPrice`/`underlyingName` 取组内 `symbol === underlyingKey` 且为正股的成员(若有)。
3. **不在此函数内排序**:排序交给表层 TanStack。现有表默认按 `symbol` 升序,而 OCC 符号编码为 `标的+YYMMDD+C/P+行权价`,正股代码是其 OCC 的前缀,故 symbol 升序天然产出「正股在前→按到期→按行权价」的腿顺序,且分组与单条持仓按标的代码交错。函数只需保证分组结构与合计正确。
4. 返回 `HoldingRow[]`(顺序不限,由表层排序决定)。

### 3.4 合计规则(父行)
所有金额用 **base 货币**(`Holding.marketValue.base` 等始终存在),规避多币种混算:
- `marketValueBase = Σ subRow.marketValue.base`(空头腿为负,自然净额)。
- `costBasisBase = Σ subRow.costBasis?.base ?? 0`。
- `totalGainBase = Σ subRow.totalGain?.base ?? 0`;`totalGainPct = costBasisBase != 0 ? totalGainBase / Math.abs(costBasisBase) : null`。
- `dayChangeBase = Σ subRow.dayChange?.base ?? 0`;`prevCloseSum = Σ subRow.prevCloseValue?.base ?? 0`;`dayChangePct = prevCloseSum != 0 ? dayChangeBase / Math.abs(prevCloseSum) : null`。
- `weight = Σ subRow.weight`。
- `underlyingPrice`:组内 `instrument.symbol === underlyingKey` 的正股成员的 `price`,否则 `null`(价格列留空)。
- `underlyingName`:同一正股成员的 `instrument.name`,否则 `null`。
- `baseCurrency`:取 `holdings[0].baseCurrency`。
- 数量列:父行留空(跨腿数量不可加总)。

## 4. 渲染与交互

### 4.1 TanStack 集成
- 现状:共享 `DataTable`(`packages/ui/.../data-table/index.tsx`)**不支持子行/展开**(无 `getSubRows`/`getExpandedRowModel`/expanded 状态)。被 8 处复用。
- **加法式扩展共享 DataTable**(向后兼容、选配):新增可选 prop `getSubRows?: (row, index) => TData[] | undefined` 与 `defaultExpanded?`;内部加 `getExpandedRowModel()` 与 `expanded` 状态(用既有 `usePersistentState`,key=`${storageKey}:expanded`)。**不传 `getSubRows` 时行为与现状完全一致**,8 个现有表不受影响。渲染循环无需改(子行经 `getRowModel().rows` 自动平铺,缩进/展开器放在 cell 内)。
- holdings 表传入 `getSubRows: (row) => isHoldingGroupRow(row) ? row.subRows : undefined` 与 `defaultExpanded: true`(默认全展开)。
- `filterFromLeafRows: true`,使子项命中搜索/faceted 筛选时父组仍显示。
- 列定义改为 `ColumnDef<HoldingRow>`,各列 cell/accessor/sortingFn 按 `isHoldingGroupRow(row.original)` 分支:`group` 渲染合计/展开器;否则渲染现有单条 cell(尽量不改既有 leaf 渲染)。

### 4.2 列展示
- **Position 列**:
  - 父行:展开/折叠箭头 + `TickerAvatar(underlyingSymbol)` + `underlyingName` + 计数徽标 `(memberCount)`。
  - 子行:在现有渲染上加左缩进;保留期权副标题(`Mar 29 $150 CALL`)与「contracts/shares」单位。
- **价格列**:父行 = `underlyingPrice`(无则空);子行不变。
- **市值 / 成本 / 未实现盈亏 / 今日盈亏 / 权重**:父行 = 合计(base 货币,复用 `AmountDisplay`/`GainPercent`);子行不变。
- **数量列**:父行留空(或显示 `memberCount`,实现时取留空为默认)。
- 其它列(资产类型、货币等):父行留空或显示标的层信息;子行不变。

### 4.3 开关与持久化
- 表头工具区新增「按标的归组」开关(沿用项目内 toggle/segmented 组件风格)。
- localStorage:
  - `holdings.groupByUnderlying`(boolean,默认 `true`)。
  - `holdings.collapsedUnderlyings`(string[],记录被用户折叠的 underlyingKey;默认空 = 全部展开)。
- 关闭开关 → 渲染原扁平 `Holding[]`,行为与现状一致。

### 4.4 排序与筛选
- 保留现有默认排序 `symbol` 升序(分组/单条按标的代码交错;组内正股在前、再按到期/行权价,由 OCC 前缀性质天然得到)。symbol 列的 `accessorFn`/`sortingFn`/`filterFn` 需对 group 行返回 `underlyingSymbol`。
- 用户点击任意列排序时,顶层与子行均按该列排序(TanStack 默认对各层排序),属显式操作,可接受。各可排序列的 accessor/sortingFn 对 group 行读合计字段。
- 搜索框与 faceted(资产类型)筛选:依赖 `filterFromLeafRows`,任一子项命中即显示其父组。

## 5. 边界情况
- **多币种组**:父行只用 base 货币合计;不展示 local 合计。
- **portfolio / 多账户 scope**:`getHoldings` 已按 asset 跨账户聚合(`source_account_ids`),归组在聚合结果上进行,逻辑不变。
- **空头腿(负数量/负市值)**:按原值求和,组净市值可能为负(如净权利金为负的价差),`AmountDisplay` 已支持负值。
- **只有期权腿、无正股**(≥2 腿):成组,`underlyingPrice` 留空。
- **孤立单条期权**:单成员 → 平铺,渲染与现状一致(已显示标的 + 副标题)。
- **非期权多条同标的**(如同一标的多个手工 lot 合并后通常为一条;若出现多条):按 ≥2 规则成组,行为一致。

## 6. 改动文件
- `packages/ui/src/components/ui/data-table/index.tsx`(改) — 加法式可选子行/展开支持(`getSubRows`、`defaultExpanded`、`getExpandedRowModel`、`expanded` 持久化);不传则零行为变化。
- `apps/frontend/src/pages/holdings/utils/group-by-underlying.ts`(新增) — 纯函数:`getUnderlyingKey`、`groupHoldingsByUnderlying`、`isHoldingGroupRow` + 类型 `HoldingGroupRow`/`HoldingRow`。
- `apps/frontend/src/pages/holdings/components/holdings-table.tsx`(改) — 接入归组模式、展开器、父行 cell、列 accessor/sort 分支、开关。
- 复用:`apps/frontend/src/lib/occ-symbol.ts`、`packages/ui` 的 `AmountDisplay` / `GainPercent` / `TickerAvatar` / `usePersistentState`。
- 测试(新增):`group-by-underlying.test.ts`、DataTable 子行渲染测试、`holdings-table.test.tsx`。

## 7. 测试
- **`group-by-underlying.ts` 单元测试**:
  - 期权 OCC → underlying 解析、正股自身为键。
  - ≥2 成组、单成员平铺。
  - 合计:含空头负腿净额、多币种用 base、成本为 0 时百分比为 null、prevClose 求和算 dayChangePct。
  - 子项排序:正股在前 → 到期 → 行权价。
  - 顶层按合计市值降序。
- **组件测试**(沿用前端测试方式):
  - 默认开 → 同标的多条折叠为父行,显示 `(n)`。
  - 展开/折叠;折叠状态写入并读取 localStorage。
  - 关闭开关 → 回到扁平表。
  - 搜索命中子项 → 父组显示(`filterFromLeafRows`)。

## 8. 已确认决策
- 实现路线:TanStack 子行展开(保留列显隐/搜索/筛选/排序)。
- 归组默认:开,可关闭。
- 父行默认展开,折叠状态持久化。
- 成组阈值:同标的成员 ≥2。
- 平台:仅自托管 Web 桌面;移动端与 Tauri 专属不做。

## 9. 验收标准
1. 默认进入 Investments 表即按标的归组:同标的(正股 + 期权腿)折叠在一个父行下,父行显示合计市值/成本/未实现盈亏/今日盈亏,正股现价显示在价格列,名称后有 `(n)`。
2. 单标的单持仓(如仅 TSLA)仍为平铺单行。
3. 点击父行可展开看到各腿(正股在前,期权按到期/行权价),再次点击折叠;刷新后折叠状态保留。
4. 关闭「按标的归组」开关 → 表格回到现状扁平形态;开关状态刷新后保留。
5. 搜索/资产类型筛选命中某腿时,其所属父组可见。
6. 空头腿、多币种、多账户聚合场景下合计数值正确(base 货币)。
7. 不触碰后端;Web 构建通过,既有前端测试不回归。
