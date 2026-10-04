# 香方配伍与窖藏陈化档案（gbincense）

面向香道工作室与制香作坊的配方留档工具：把每款香方的香料配比、炮制方式、和香成型、窖藏陈化与品香评鉴逐环记录，形成可复用的香方档案。

核心动作：**建香方与用途 → 维护香料库与炮制方式 → 按君臣佐使配比（改方即生成版本）→ 排和香工序与成型 → 管窖藏批次环境（入窖前比对快照）→ 录品香评分（待复核批次不并入均分）**。

**版本链（v3 起）**：香方、配比、批次、窖藏共用同一条版本号序列。配比一改，未入窖批次的快照立即失效并按新方重算；已入窖批次永久冻结入窖当刻的原快照与依据版本；旧档缺快照的批次先置「待复核」，其品香不自动并入均分，人工复核后才锚定版本。两个页面 / 标签页同时编辑同一款香方时，后保存者的修改不会覆盖先保存者，而是留为冲突草稿并报冲突。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后依然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22822**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改（默认 `22822`）；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbincense}-frontend`。
> `docker-compose.yml` 已用顶层 `name: gbincense` 兜底，任意目录名（含中文）下 `docker compose config --quiet` 都不会报错。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；换设备请用应用内「导出全量 JSON」与「导入 JSON」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals` / `noUnusedParameters` 均开启） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、抽屉、对话框、表单、滑块、提示 |
| 构建工具 | Vite 6 | 开发服务器端口 22822 |
| 状态管理 | Pinia 2（setup store） | `formulaStore` / `materialStore` / `proportionStore` / `cellarStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files $uri $uri/ /index.html` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 库名 `gbincense`，含结构版本号与 `upgrade` 迁移逻辑 |
| 拖拽排序 | HTML5 原生 `draggable` + `dragstart/dragover/drop` | 未引入 `vuedraggable` / `dnd-kit` 等额外依赖 |
| 容器化 | Docker 多阶段：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22822
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22822）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、目录结构与页面路由

```
sologsb101-1022/
├── README.md
├── docker-compose.yml          # 顶层 name 兜底，无 version 字段，无挂卷
├── .env / .env.example         # COMPOSE_PROJECT_NAME=gbincense、FRONTEND_PORT=22822
├── .gitignore
├── sologsb101-1022.md          # 提示词原文（只读）
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # SPA fallback + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：先 initDatabase() 播种，再挂载应用
        ├── App.vue             # 顶部导航（6 个模块）+ 底部数据说明
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # formula.ts material.ts proportion.ts batch.ts cellar.ts tasting.ts version.ts
        ├── stores/             # formulaStore.ts materialStore.ts proportionStore.ts cellarStore.ts conflictStore.ts
        ├── components/common/  # GradeTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue VersionTag.vue
        ├── hooks/              # useProportion.ts useIdbTable.ts
        ├── pages/              # FormulaList.vue MaterialLib.vue ProportionBoard.vue
        │                       # BatchList.vue CellarView.vue TastingBoard.vue
        ├── router/index.ts
        └── utils/              # ratio.ts db.ts export.ts versioning.ts
```

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/formulas` | 香方台账 | 新建/编辑香方、按香型与用途与状态筛选、卡片回显配比合计与品香均分、状态流转（草稿 → 在用 → 停用）、单方 JSON 导出与导入校验 | Formula、Tasting、Proportion、Batch |
| `/materials` | 香料库与炮制 | 香料增删改、按等级/产地/炮制方式检索、就地改炮制方式、显示被哪些香方引用、清理闲置香料 | Material、Proportion |
| `/proportions` | 配比与君臣佐使 | 君臣佐使编排、占比实时校验 100%、一键等比缩放与归一化、**HTML5 原生拖拽排序写回 `seq`**、按权重一键重排 | Proportion、Formula、Material |
| `/batches` | 和香工序与成型 | 登记和香批次（固化现行配比快照并锚版本）、快照版本链轨迹与逐味对照、待复核批次人工复核、开批次前校验配比是否平衡 | Batch、Formula、Proportion、FormulaVersion |
| `/cellar` | 窖藏与环境 | 入窖前逐味比对快照与现行配比（不一致拒绝并列差异、待复核拒绝）、入窖冻结原快照、温湿度就地录入、按剩余天数排序的临近出窖提醒、删除窖藏自动解冻重算、台账标出入窖依据版本 | Cellar、Batch、Formula |
| `/tastings` | 品香评鉴与导出 | 香韵 / 留香 / 烟气评分录入、同批次多次评鉴取均分（待复核批次不并入）、每条评鉴标出依据版本、结构版本查看、全量 JSON（含版本链 / 冲突草稿）导出与导入校验 | Tasting、Batch、全部模型 |

`/` 与未匹配路径均重定向到 `/formulas`；页面组件全部懒加载，`router.afterEach` 同步 `document.title`。

---

## 五、IndexedDB 库名与数据存储说明

- **库名**：`gbincense`（`frontend/src/utils/db.ts` 中的 `new IncenseDatabase()` → `super('gbincense')`）。
- **结构版本号**：`export const DB_VERSION = 3`，同时写入 localStorage 键 `gbincense:db-version` 便于比对。

| 表 | 主键与索引 | 说明 |
| --- | --- | --- |
| `formulas` | `id, name, scentType, usage, state, createdAt, totalRatio, versionNo, rev, updatedAt` | 香方主档；`versionNo` 指向版本链链尾，`rev` 为乐观并发修订号（香方 / 配比任何改动都自增） |
| `materials` | `id, name, origin, grade, processMethod, updatedAt` | 香料库与炮制方式 |
| `proportions` | `id, formulaId, materialId, role, seq, updatedAt` | 君臣佐使配比，`seq` 为拖拽编排顺序 |
| `batches` | `id, formulaId, mixedAt, formingMethod, snapshotState, updatedAt` | 和香批次；`snapshotState` 为 `current`（现行，随新方重算）/ `frozen`（已入窖冻结原快照）/ `pending_review`（旧档缺快照待复核），另含 `formulaVersionNo` 锚定版本与 `versionTrail` 版本轨迹 |
| `cellars` | `id, batchId, startDate, endDate, state, updatedAt` | 窖藏批次与环境读数；`formulaVersionNo` 记录入窖依据版本 |
| `tastings` | `id, batchId, tastedAt, smokeScore, updatedAt` | 品香评鉴 |
| `formulaVersions` | `id, formulaId, versionNo, createdAt` | 香方版本链：每次配比指纹变化（香料增删 / 占比 / 角色）追加一节点，固化当时完整快照；备注与排序变化只递增 `rev` 不新增版本 |
| `conflictDrafts` | `id, formulaId, kind, resolved, createdAt` | 并发编辑冲突时后保存者留下的草稿（香方主档 / 配比明细） |

- **版本链规则**（`frontend/src/utils/versioning.ts`）：
  1. **配比变更**：`rev` 与打开编辑时的基线不一致即抛 `RevisionConflictError`，本次修改整体回滚并落为冲突草稿；一致时若快照指纹变化则追加新版本，未入窖且非待复核批次的快照在同一事务内立即按新方重算，已入窖批次保持冻结。
  2. **登记批次**：固化现行配比快照并锚定当前版本；现行配比指纹与链尾不同（如导入数据）时自动补一个「和香固化」版本。
  3. **入窖**：入窖前逐味比对批次快照与现行配比（`compareSnapshot`，区分占比调整 / 已移除 / 新增）。待复核批次拒绝入窖；快照不一致拒绝入窖并弹出全部香料差异；一致才冻结原快照、写入窖藏并记录依据版本。删除窖藏记录后批次解除冻结，按现行方重新计算快照。
  4. **待复核**：旧档缺快照的批次置 `pending_review`，其品香评鉴在香方台账与品香页均**不自动并入均分**；批次页可一键「按现行配比复核」，复核通过补建快照并锚定版本后才计入。
  5. **导出与台账**：每条窖藏、批次、品香都以 `VersionTag` 标出依据版本；单方导出 JSON 含完整 `formulaVersions` 与 `ledger`（当前版本、待复核 / 冻结批次数、计入均分的批次），全量快照含 `formulaVersions` 与 `conflictDrafts`。
- **版本迁移**：
  - `version(1)` 为初版；`version(2)` 补 `seq` 索引并回填批次快照、品香留香；
  - `version(DB_VERSION=3)` 新增版本链与冲突草稿表，`upgrade` 为旧档补版本：每方先把已入窖且与现行方不同的旧快照补为历史版本（相同指纹只补一个），链尾补当前配比版本；已入窖批次冻结锚历史版本，未入窖批次立即按现行方重算锚链尾，缺快照批次置待复核；窖藏记录锚定对应批次版本。
- **首屏自动播种**：`main.ts` 在挂载前调用 `initDatabase()`，其中包含 `if ((await db.formulas.count()) === 0) { await seedDatabase() }`，写入 3 款香方 → 版本链 / 7 条配比 / 3 个和香批次（1 个已入窖冻结 v1、1 个现行、1 个旧档待复核）→ 1 条窖藏 / 2 条品香（待复核批次的品香不并入均分）。播种使用固定 id + `bulkPut`，**幂等**，重复调用不会产生重复数据。
- **localStorage 元数据**：`gbincense:db-version`（结构版本）、`gbincense:last-backup-at`（上次导出时间）、`gbincense:ui-prefs`（当前香方、配比与窖藏排序方式）。
- **导出 / 导入**：`utils/export.ts` 提供 `exportFormulaJson()`（单方）与 `exportSnapshotJson()`（全量），导入前用 `validateFormulaJson()` / `validateSnapshotJson()` 做字段与枚举校验，校验失败会提示具体错误且不写库。
- **无命名卷、无后端**：数据只在本浏览器，清理浏览器站点数据即清空；应用内提供「重置演示数据」按钮可恢复样例档案。

---

## 六、常见问题

1. **端口被占用**：修改 `.env` 中的 `FRONTEND_PORT`（例如 `FRONTEND_PORT=22823`）后重新 `docker compose up -d --build`；本地开发改 `frontend/vite.config.ts` 的 `server.port`。
2. **favicon 或静态资源 403**：`Dockerfile` 在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后紧接 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机源文件权限为 `0600` 时 nginx worker（uid=101）读不到文件，已被规避。
3. **刷新子路由 404**：`nginx.conf` 已配置 `try_files $uri $uri/ /index.html;`；若自行部署到其它 Web 服务器，请同样配置 history fallback。
4. **换浏览器 / 换设备看不到数据**：数据仅存于当前浏览器的 IndexedDB，请在「品香评鉴」页导出全量 JSON，再在新环境导入。
5. **配比合计不是 100%**：配比页顶部会实时显示合计与偏差，可点「一键等比缩放至 100%」或「按君臣佐使重排」后微调；批次页登记前也会提示当前方子是否平衡。
6. **改方后旧批次怎么办**：未入窖批次的快照会在配比保存的同一事务内立即失效、按新方重算并锚定新版本；已入窖批次永久保留并冻结入窖当刻的原快照（`frozen`），不受后续改方影响——这正是入窖前必须通过快照比对的原因。版本轨迹可在批次页「快照对照与版本链」抽屉中按时间线查看。
7. **入窖被拒绝**：弹窗会逐条列出香料差异（占比调整 / 现行方已移除 / 现行方新增）。未入窖批次正常情况下快照已随新方重算、与现行方一致；若坚持按旧快照入窖，说明该批次应在改方前完成入窖，请核对批次或版本链后再操作。
8. **「待复核」批次**：由旧版数据迁移而来、缺少配比快照。其品香评鉴不会自动并入香方均分；在批次页打开对照抽屉，确认后点「按现行配比复核」即可补建快照、锚定版本，之后评鉴自动计入。
9. **两页同时编辑提示冲突**：后保存者的内容不会覆盖先保存者，系统会把后保存者的香方主档 / 配比明细留为冲突草稿（香方台账与配比页顶部有红色横幅）。可打开草稿对照内容手工合并，或直接放弃 / 清除。
10. **导出文件里的版本信息**：单方 JSON 含 `formulaVersions` 版本链与 `ledger`（当前版本、待复核 / 冻结批次数、计入均分的批次清单）；全量 JSON 另含 `conflictDrafts`。旧版（v2）导出文件仍可导入，导入时自动补版本链、缺快照批次置待复核。
11. **浏览器隐私模式**：部分浏览器的无痕窗口会禁用或限制 IndexedDB，可能导致看不到演示数据，请使用普通窗口访问。
