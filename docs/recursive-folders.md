# Timeline 递归文件夹改造与验收

基线：`williememanon-hub/chatgpt-gemini-timeline` 的 `378508df938008429d3fb6042daf7c58ede6bab4`。
2026-10-15 通过 GitHub 连接核对，远端 `main` 指向该提交。本次开发分支为 `feat/recursive-starred-folders`。

## 1. 数据模型与完整调用关系

数据仍由 `js/timeline/common.js` 中的 `StorageAdapter` 写入 `chrome.storage.local`。没有引入新数据库、迁移版本或嵌套存储格式。

| 存储键 / 字段 | 原有含义 | 本次处理 |
| --- | --- | --- |
| `folders` | 平铺的文件夹数组 | 保留 |
| `id` | 文件夹的稳定 ID | 移动、改名时不变 |
| `parentId` | 父文件夹 ID；`null` 表示根 | 允许任意有效祖先链；旧数据缺少该字段也按根处理 |
| `name`, `icon`, `createdAt` | 名称、图标、创建时间 | 保留 |
| `order` | 同一父级内的位置 | 相关同级在创建、移动、删除后重新编号 |
| `pinned` | 可选的置顶标记 | 每一级都先显示置顶文件夹，再按 `order` 排序 |
| `chatTimelineStars` | 全部收藏的数组，由 `StarStorageManager` 负责 | 保留 |
| 收藏的 `key` | `chatTimelineStar:{urlWithoutProtocol}:{nodeKey}` | 保持原始字符串，不用数字索引重造 key |
| 收藏的 `folderId` | 所属文件夹的稳定 ID | 移动目录时不改；移动收藏时才改 |
| 收藏的 `nodeId` / `index`, `question`, `url`, `timestamp`, `pinned` | 节点/对话标识、标题等 | 保留既有映射与排序方式 |
| `sidebarStarredFolderStates` | `{ [folderId]: boolean }`，侧栏展开状态 | 原有任意 ID 映射本身不限制深度，继续使用 |
| 收藏 Tab 的 `folderStates` | 由 `BaseTab` 管理的持久状态 | 继续使用 |

`FolderManager` 的实例注入 `StorageAdapter` 来读写 `folders`；收藏操作仍委托原有全局 `StarStorageManager`，后者使用同一个 `StorageAdapter`。测试替换这个 I/O 适配器，并加载真实的两个管理器，未用一份重新实现的收藏逻辑冒充被测代码。

| 消费方 | 调用与用途 |
| --- | --- |
| `StarredTab.updateList()` | `getStarredByFolder()` → 共享 `StarredTreeRenderer.renderTree()` |
| `SidebarStarredManager._refreshContent()` | 同样的建树与渲染入口；负责注入、刷新及侧栏生命周期 |
| `StarredTreeRenderer` | 创建/编辑/删除/置顶、文件夹拖放、收藏拖放及排序 |
| `StarInputModal` | `getFolderTree()` 生成递归选择菜单，`getFolderPath()` 显示完整路径，`createFolder()` 新建所选父级的子目录 |
| `GlobalDropdownManager` | 实际展示上述菜单；本次另发现并移除它的三级菜单上限 |
| `TimelineManager` | 在收藏时调用 `StarInputModal`，把返回的 `folderId` 写入原有收藏记录 |
| `NotepadManager` | 使用同一个弹窗，并通过 `getFolderPath()` 显示笔记所属目录 |
| `BaseSidebarStarredAdapter` | 原生对话菜单收藏入口，通过弹窗获取任意深度的 `folderId` |
| 原生对话拖入侧栏 | `SidebarStarredManager` 的鼠标拖动 → renderer 命中检测 → 原有收藏存储流程 |
| 数据同步 Tab | 原样导出/导入整个 Storage 数据；不用重新定义文件夹格式 |

## 2. 原源码中发现的限制与对应改动

| 位置 | 原来问题 | 实现 |
| --- | --- | --- |
| `createFolder()` | 阻止在子目录下再建目录 | 校验父级存在且祖先链无环，无固定深度上限 |
| `getStarredByFolder()` | 手工构建根 + 一层子目录 | 建立所有 ID 的索引，统一连接所有父子关系，再按 ID 分配收藏 |
| `deleteFolder()` | 只删除自身及直接子目录 | 栈遍历全部后代，用同一 ID 集合处理目录和收藏 |
| `getFolderPath()` | 只取当前名称与直接父名称 | 沿父指针追溯到根，反转后连接 |
| `moveFolderToParent()` | 有子目录就不能嵌套；目标必须是根 | 允许整棵子树移动，检查目标的完整祖先链 |
| `moveFolderToPosition()` | 只能同级排序 | 可移到任意目标前后，同时改为目标的父级；复用循环检查 |
| 收藏移动与排序 | 没有校验目标 ID；自己作为参照也可能被移到末尾 | 拒绝不存在的目标；自身参照不操作；参照项必须属于目标目录 |
| renderer 文件夹菜单 | 只有第一级显示“新建子文件夹” | 每级都可新建；非根文件夹增加“移到根目录” |
| renderer 拖放 | 只有根文件夹可作为移入目标 | 每级都使用统一的三个落点区域 |
| renderer 搜索 | 只检查直接子目录是否命中 | 递归检查后代，保留通向深层命中的祖先链 |
| renderer 删除确认 | 最多查找到第二级 | 递归查找待删节点，原有递归计数负责完整删除范围的提示 |
| `StarInputModal` | 只列出两级、手工拼接两段路径 | 递归生成每一级及其新建子目录选项，完整路径与选择 ID 一致 |
| `GlobalDropdownManager` | `_showSubmenu()` 明确拒绝第三级子菜单之后的内容 | 移除硬上限；点击判断检查全部活跃子菜单；横向位置约束在视口内 |
| ChatGPT 侧栏 CSS | 深层内容缺乏独立横向查看空间 | 仅扩展的 ChatGPT 列表滚动，行有最小可操作宽度，外层限制宽度 |

`renderFolder()` 原有的递归结构继续使用。没有新增平行的文件夹渲染框架，也没有为第 3、4、5、6、7 级分别添加分支。

## 3. 从第一性原理理解实现

### 平铺存储为什么能表达一棵树？

一条 `parentId` 关系已经回答了“这个目录直接属于谁”。例如下面七条记录足以表达七级目录：

| id | parentId |
| --- | --- |
| L1 | null |
| L2 | L1 |
| L3 | L2 |
| L4 | L3 |
| L5 | L4 |
| L6 | L5 |
| L7 | L6 |

这样的表示叫**邻接表**。存储中的数组是平的，但它表达的关系可以很深。将 L3 移到另一个目录 X 下，只需要把 L3 的 `parentId` 改成 X；L4 到 L7 的父指针仍然正确。收藏指向稳定的目录 ID，也不用跟着改路径。

读数据时，`Map` 提供“按 ID 找到对象”的索引。先给每个文件夹创建一个内存节点，再执行类似下面的连接：

```js
byId.get(folder.parentId).children.push(folder);
```

这里放入的是同一个内存节点的引用。每个节点都有一致的 `children: []` 和 `items: []`。存储仍只保存原来的 `parentId`；`children`、`items` 是派生的显示结构，不写回 Storage。

### 递归为什么不需要知道最多有几层？

递归只要求：对子目录做的事情，与对当前目录做的事情相同。
实际渲染器保留了这个核心：

```js
for (const child of folder.children) {
    await this.renderFolder(child, content, level + 1, renderVersion);
}
```

没有子目录时，循环执行零次，这就是停止条件。树的深度来自数据，算法无需提前写出七套代码。搜索、删除确认查找和收藏选择菜单也沿用这个关系。

### 删除为什么必须遍历全部后代？

删除 L3 的范围是 L3，以及 L3 的子目录的完整删除范围；不能只看 L4。
数据层用一个显式的栈保存“尚未处理的目录”，等价于深度优先递归：

```js
const deletedIds = new Set();
const pending = [folderId];
while (pending.length > 0) {
    const id = pending.pop();
    if (deletedIds.has(id)) continue;
    deletedIds.add(id);
    for (const childId of children.get(id) || []) pending.push(childId);
}
```

栈为空表示全部后代已经处理。`Set` 既去重，也防止已存在的循环坏数据导致无限循环；使用显式栈还避免了删除遍历对 JavaScript 调用栈深度的依赖。

之后用**同一个 `deletedIds`**过滤目录和收藏。原有默认 `deleteItems: true` 会删除其中所有收藏；显式传入 `false` 会把全部后代收藏的 `folderId` 设为 `null`，保留标题、key、备注等其它字段。界面的删除入口继续沿用原来的删除语义，并提示完整收藏数量。

### 移动怎样防止形成环？

如果要把 A 移进 B，就从 B 一直向父级走。途中遇到 A，说明 B 已经是 A 的后代；再连 A → B 会形成循环，必须拒绝。允许移动到自己的祖先，因为这只会把子树提升，并不会形成循环。

`_validateParent()` 还用 `Set` 记录走过的 ID。如果目标链本来已经在循环，或链上的父级不存在，也拒绝写入。这个校验同时用于“移入”和“移到目标前后”，所以绕过界面直接调用管理器也不能创建环。

构建显示树时，对旧数据的悬空父级和循环做只读容错：在内存里把缺失父级的节点、或环上的一条边提升为根。这样已有目录和收藏不会消失；不会悄悄改写存储。修复此类目录可以使用“移到根目录”，再安排新的父子关系。

### 横向滚动为什么还需要最小行宽？

每层已经有 24px 的缩进。如果只加 `overflow-x: auto`，浏览器仍可能不断压缩内部行，直到标题或按钮几乎没有可用空间，而没有形成有用的滚动内容。

本次保留每行至少 200px 的可操作空间；逐层缩进就会形成真正的横向溢出。滚动发生在 `.ait-sidebar-starred.chatgpt > .ait-ss-list` 内。外层使用 `width/max-width: 100%`、`min-width: 0`、`box-sizing: border-box` 和 `contain: inline-size`，防止内部内容参与原生侧栏的宽度撑开。长标题单行省略；操作按钮仍可以滚动到可见区域。

列表最大高度为 `min(60vh, 560px)`，因此很多收藏展开时，横向滚动条仍位于这块列表底部。刷新渲染前记录 `scrollLeft/scrollTop`，完成后恢复；目录尺寸缩小时由浏览器自然限制到新的有效滚动范围。没有修改 ChatGPT 的 `nav`、全局滚动容器或原生会话项 CSS。

### 规模与适用边界

建树通过索引连接节点，连接过程为 O(F)，再分别对每组同级排序；收藏分配过程为 O(S)，另加各目录内的置顶排序。F 表示文件夹数，S 表示收藏数。不是对每个目录重新扫描全部收藏。

向上追溯和删除遍历使用循环/栈；渲染与菜单继续递归。代码不设固定层数上限，但浏览器 DOM、递归调用与页面性能仍有实际极限；“任意合理深度”不等于数学上的无限深度。128 层仅做过数据层测试，未声称对 128 层完整界面完成验收。

沿用现有 Storage 的读改写方式及删除时的两次写入，没有新增跨标签页事务或崩溃恢复机制。自动化测试不证明多标签页同时修改时的事务原子性。

## 4. 自动化验证

环境：Linux、Node.js v24.19.0、Playwright 1.62.1、Chromium 153.0.8010.0、JSDOM 26.1.0。

最终 `npm test`：**30 个测试项通过，0 失败、0 跳过**。其中原仓库的回归脚本作为 6 个测试项统计，不把脚本内部的每个断言另算一项。

| 分组 | 数量 | 已验证内容 |
| --- | --- | --- |
| 模拟 StorageAdapter，真实 FolderManager + StarStorageManager | 13 | 七级创建与重读、整棵子树移动、循环/悬空父级拦截、跨级前后排序、每级置顶、收藏排序与归属、分支递归删除、`deleteItems:false`、改名后路径、旧数据与 notepad/nodeId key、坏数据只读恢复、128 层遍历 |
| Linux Chromium 真实 DOM/CSS 交互 | 11 | 横纵滚动、原生侧栏宽度不变、刷新保留滚动、折叠消除溢出、220/280/340px 和深色样式、长名称省略、跨级目录落点、拒绝拖入后代、新建第八层与移到根、深层删除确认数量、搜索祖先链、七级菜单鼠标展开及选中、收藏鼠标拖动、原生会话鼠标拖入 |
| 仓库原有回归脚本 | 6 | ChatGPT rollout、API diagnostics、DOM、定位几何及入口等现有检查 |

测试使用本地构造的 ChatGPT 侧栏结构，没有登录或访问用户的真实会话。布局通过 Chromium 的实际测量和滚动事件验证，不是用 JSDOM 的零尺寸矩形冒充布局测试。文件夹拖放通过真实 DOM 的 `DragEvent/DataTransfer` 事件模拟；收藏与原生会话拖动通过鼠标事件和真实命中检测；收藏选择菜单使用 Playwright 鼠标悬停及点击。

还在未改动的 `378508d` 源码上运行了四项反向验证：七级创建、子树跨级移动、递归删除、完整路径。这四项全部按预期失败，分别暴露原来的两级创建限制、移动限制、后代残留和两段路径，说明测试能区分原有缺陷。

测试文件：

- `scripts/tests/folder-manager.cjs`
- `scripts/tests/helpers/folder-harness.cjs`（读写都克隆，模拟 Storage 的序列化隔离）
- `scripts/tests/starred-folders-browser.cjs`

通常在 Node.js 22 或更高版本下运行：

```sh
npm ci
npx playwright install chromium
npm test
```

仅运行数据层：`npm run test:folders`。仅运行浏览器：`npm run test:folders:browser`。

已有可用 Chrome/Chromium 时，可用 `CHROMIUM_EXECUTABLE_PATH` 指定路径。Windows PowerShell 示例：

```powershell
$env:CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
```

测试不读该 Chrome 的个人配置目录，也不会读真实收藏。设置 `TIMELINE_TEST_ARTIFACTS` 可指定测试截图保存目录。

## 5. 在原有 Windows 11 Chrome 中更新与验收

1. 先在扩展的“数据同步 / 手动同步”中导出 JSON 备份。保留当前加载的扩展目录及扩展 ID。
2. 在原有本地仓库中 `git fetch origin`，检查 `git status`，保留尚未提交的本地改动，再切换到 `feat/recursive-starred-folders`。不要用覆盖或重置命令丢弃自己的改动。
3. 如果使用源码 ZIP，把更新合并到**原来 Chrome 加载的目录**。在 `chrome://extensions` 中点击原来的 Timeline“重新加载”，随后刷新 ChatGPT 页面。
4. 不要先卸载原扩展。把同一代码从另一目录作为新扩展加载，可能产生另一个扩展 ID，其 Storage 与原扩展隔离，看不到旧收藏不能据此判断数据丢失。

仍需在 Windows 的真实页面手动验收：

| 操作 | 期望结果 |
| --- | --- |
| 逐级新建 L1 到 L7，再刷新页面 | 每级都能新建、展开、改名、置顶；目录和收藏保持 |
| 在时间轴、原生会话菜单和笔记收藏中选择 L7 | 可逐层展开选择，返回完整路径及正确目录 |
| 拖有子目录的 L2 到另一个深层目录中间 | 整棵子树移动，收藏不丢失 |
| 拖到标题顶部/底部 | 排到目标前/后，属于目标的父级；操作根目录目标可提升子树 |
| 将祖先拖向自己的后代 | 不出现合法落点，不改变存储 |
| 非根目录菜单“移到根目录” | 保留后代，成为根目录 |
| 展开七级，用横向滚动条、Shift+滚轮或触控板横向查看 | 深层标题和菜单按钮可到达；原生侧栏宽度及原生对话布局不变 |
| 大量收藏展开后再刷新或修改收藏 | 只有扩展列表局部滚动，横向位置尽量保持 |
| 在深层目录删除之前先检查提示数量 | 提示包含全部后代收藏；确认后所有后代目录和相关收藏都删除 |
| Chrome 100% / 125% 缩放、Windows 常用显示缩放、深色/浅色、原生侧栏折叠再展开、SPA 切换会话 | 无按钮遮挡、错误注入或额外的页面横向滚动 |

真实 ChatGPT 当前 DOM、Windows 系统滚动条、物理鼠标的原生拖放、扩展重新加载后的持久化及多标签页并发，尚未在用户的机器上验证。测试通过的是上述模拟存储和 Linux Chromium 测试环境，不能替代这一轮验收。

字段格式兼容不意味着旧版两级 UI 能显示升级后新增的深层目录。若要完整回退，恢复代码时也应恢复升级前的备份；不要把旧版看不到深层目录误认为新版已删除这些数据。
