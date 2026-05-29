---
name: workflow
description: "执行多步骤 workflow 脚本，支持串行、并行、动态 mapParallel、条件判断（when）、循环迭代（loop）。当用户想要运行复杂的多阶段任务、编排多个 sub-agent 并行/串行工作、或使用预定义的 workflow 脚本时触发。关键词：workflow、工作流、编排、多步骤、并行分析、条件判断、循环。"
---

# Workflow 执行 Skill

> 由 `opencode-workflow-plugin` 提供。

## ⚠️ 核心原则

### 原则一：先编排，再执行

当用户提出一个复杂的多步骤任务时，**先编写 workflow 脚本**，放到 `.opencode/workflows/` 目录下，然后用 `task` 工具启动 workflow sub-agent 执行。

**脚本中不需要包含**：实际任务的详细代码、具体的实现逻辑、逐行的代码分析等。这些由 sub-agent 在执行时自行处理。

### 原则二：最大化并行 ⚡

**这是 workflow 最重要的价值**。编写脚本时，必须主动思考：

> **哪些步骤之间没有依赖关系？把它们放进 `parallel()` 或 `mapParallel()` 并行执行。**

实测数据：9 个并行 agent → **4.7 倍加速**（67s 并行 vs 319s 串行）。

```
❌ 低效：全是串行，4 个步骤耗时 4 单位时间
  agent A → agent B → agent C → agent D

✅ 高效：识别独立步骤，并行执行，耗时 2 单位时间
  agent A ─┐
  agent B ─┤ → 综合结果
  agent C ─┤
  agent D ─┘
```

**编写脚本时的思考清单**：
1. 🔍 **找独立步骤**：哪些步骤互不依赖、可以同时执行？→ 用 `parallel()`
2. 📋 **找批量操作**：是否需要对一组同类对象做相同操作？→ 用 `mapParallel()`
3. 🔗 **只串行有依赖的**：前一步的输出是后一步的输入时，才用串行 `await agent()`

**常见并行机会**：
| 场景 | 并行模式 |
|------|----------|
| 从多个维度分析同一份数据 | `parallel()` — 安全/风格/性能同时审查 |
| 分析多个文件/目录/模块 | `mapParallel()` — 每个文件一个 agent |
| 搜索 + 分析 + 生成 | 串行（有依赖） |
| 先扫描再深入分析每个子项 | 先串行扫描，再 `mapParallel()` 深入 |

### 对比示例

```javascript
// ❌ 低效脚本：全部串行，4 个 agent 耗时 ~320 秒
phase('分析项目')
const security = await agent('从安全角度审查代码...', { label: '安全' })
const style = await agent('从风格角度审查代码...', { label: '风格' })
const perf = await agent('从性能角度审查代码...', { label: '性能' })
const report = await agent('综合所有审查结果生成报告...', { label: '报告' })

// ✅ 高效脚本：独立步骤并行，耗时 ~80 秒（4 倍加速）
phase('并行审查')
const [security, style, perf] = await parallel([
  () => agent('从安全角度审查代码...', { label: '安全' }),
  () => agent('从风格角度审查代码...', { label: '风格' }),
  () => agent('从性能角度审查代码...', { label: '性能' }),
])

phase('综合报告')
const report = await agent('综合所有审查结果生成报告...', { label: '报告' })
```

```javascript
// ✅ 好的 workflow 脚本：只描述编排逻辑，最大化并行
export const meta = {
  name: 'code-review',
  phases: [
    { title: '收集变更', detail: '获取 PR diff' },
    { title: '并行审查', detail: '从多个维度审查代码' },
    { title: '综合报告', detail: '汇总审查结果' },
  ],
}

phase('收集变更')
const diff = await agent(`运行 git diff HEAD~1，收集所有变更文件和内容`, {
  label: '获取 diff',
  phase: '收集变更',
  schema: DIFF_SCHEMA,
})

phase('并行审查')
const [security, style, perf] = await parallel([
  () => agent(`基于以下 diff，从安全角度审查代码...`, { label: '安全审查' }),
  () => agent(`基于以下 diff，从代码风格角度审查代码...`, { label: '风格审查' }),
  () => agent(`基于以下 diff，从性能角度审查代码...`, { label: '性能审查' }),
])

phase('综合报告')
return { security, style, perf }
```

### 第二步：启动 Workflow Sub-agent 执行

**脚本写完后，必须使用 `task` 工具启动 workflow sub-agent 来执行它**，不要自己手动逐步执行。

```
task(
  subagent_type: "workflow",
  prompt: "执行 workflow 脚本: .opencode/workflows/<name>.js\n\n请读取该脚本文件，调用 workflow-parse 工具解析执行计划，然后按计划逐步执行。",
  description: "执行 <name> workflow"
)
```

### 完整流程总结

```
用户提出复杂任务
  → 主 Agent 分析任务，了解全貌
  → 编写 workflow 脚本（只含编排逻辑，不含详细代码）
  → 保存到 .opencode/workflows/<name>.js
  → 使用 task 工具启动 workflow subagent 执行
  → workflow agent 自动解析、调度、并行执行
  → 返回最终结果给用户
```

## 触发条件

当用户需要执行复杂的多步骤任务时，使用本 skill。典型场景：

- "帮我全面了解这个项目"
- "运行 understand-project workflow"
- "并行分析多个子项目"
- "用 workflow 模式做代码审查"
- "先测试，失败了就修复，通过后再部署"
- "迭代优化直到满意为止"
- 任何需要 3 个以上步骤的复杂任务

## 工作方式

Workflow 通过一个专用的 **workflow agent** 来编排多个 sub-agent 执行任务：

```
用户 → 主 Agent → task("workflow") → workflow agent
                                      ├── task("explore") → sub-agent A
                                      ├── task("explore") → sub-agent B
                                      ├── task("general") → sub-agent C
                                      └── ...
                                      最终结果 → 返回主 Agent
```

**核心优势**：
- ⚡ **并行加速（最大价值）**：多个独立任务在同一 response 中以多个 task calls 并发发出，实测 **4.7 倍加速**。这是使用 workflow 的首要原因——**任何可以并行的步骤都不应该串行执行**。
- **动态扩展**：`mapParallel` 根据运行时数据动态展开并行 agent，不需要预先知道数量。
- **编排能力**：通过脚本精确控制哪些步骤串行（有依赖）、哪些并行（无依赖）。
- **条件分支**：`when` 根据前序步骤结果选择不同执行路径。
- **循环迭代**：`loop` 重复执行直到满足退出条件（如测试通过）。
- **结果隔离**：中间结果留在 workflow agent 上下文中，不污染主对话。

## Workflow 脚本格式

脚本放在 `.opencode/workflows/` 目录下，使用 JS DSL 编写。

**脚本定位**：workflow 脚本是「编排文档」，不是「实现代码」。它描述的是任务的**结构**，而不是**细节**。

```javascript
// 元信息
export const meta = {
  name: 'my-workflow',
  description: '描述这个 workflow 做什么',
  phases: [
    { title: '阶段一', detail: '做什么' },
    { title: '阶段二', detail: '做什么' },
  ],
}

// Schema 定义（用于约束 sub-agent 输出格式）
const MY_SCHEMA = {
  type: 'object',
  properties: {
    field1: { type: 'string', description: '字段说明' },
  },
}

// 阶段标记
phase('阶段一')

// 日志
log('开始分析...')

// 单个 agent 调用
const result = await agent(`prompt 文本`, {
  label: '步骤标签',
  phase: '阶段一',
  schema: MY_SCHEMA,
})

// 并行调用
const results = await parallel([
  () => agent(`分析 A...`, { label: 'A' }),
  () => agent(`分析 B...`, { label: 'B' }),
])

// 动态并行（mapParallel）
const items = ['a', 'b', 'c']
const analyses = await parallel(
  items.map(item => () => agent(`分析 ${item}...`, { label: `分析:${item}` }))
)

// 条件判断（when）
await when('分析结果中发现了安全漏洞', async () => {
  await agent(`生成安全修复计划...`, { label: '安全修复' })
})

// 条件判断 with else
await when('测试全部通过',
  async () => {
    await agent(`执行部署...`, { label: '部署' })
  },
  async () => {
    await agent(`生成失败报告...`, { label: '报告失败' })
  }
)

// 循环迭代（loop）
await loop('所有测试通过，0 个失败', async () => {
  await agent(`分析失败的测试并修复代码，然后重新运行测试...`, { label: '修复测试' })
}, { maxIterations: 5, label: '测试修复循环' })

// 最终返回
return { result, analyses }
```

## 核心能力

### 串行编排

有依赖关系的步骤按顺序执行，前一步的结果传递给后一步的 prompt。

### 并行执行（`parallel()`）

多个互不依赖的 agent 在同一 response 中并发发出。适合：
- 同时分析多个子项目 / 多个模块
- 同时检查代码的多个维度（安全、风格、性能）

### 动态并行（`mapParallel()`）

根据运行时数据动态展开并行 agent。不需要预先知道有多少项。

### 条件判断（`when(condition, thenBlock, elseBlock?)`）

基于前序步骤的运行时结果选择不同执行路径。

- `condition`：**自然语言条件**，由 LLM 在运行时评估
- `thenBlock`：条件为真时执行的步骤
- `elseBlock`（可选）：条件为假时执行的步骤
- 支持嵌套（else 中可以再嵌 when）

```javascript
// 简单条件
await when('分析结果包含错误', async () => {
  await agent('修复发现的错误...', { label: '修复错误' })
})

// if-else
const outcome = await when('代码质量评分高于 80',
  async () => {
    return agent('执行部署流程...', { label: '部署' })
  },
  async () => {
    return agent('生成改进建议报告...', { label: '改进建议' })
  }
)

// 嵌套条件
await when('severity === "critical"',
  () => agent('紧急修复...', { label: '紧急修复' }),
  () => when('severity === "medium"',
    () => agent('安排修复...', { label: '安排修复' }),
    () => agent('加入待办...', { label: '加入待办' })
  )
)
```

### 循环迭代（`loop(condition, body, { maxIterations, label? })`）

重复执行步骤直到满足退出条件。

- `condition`：**自然语言退出条件**，描述什么时候停止循环
- `body`：每次迭代执行的步骤
- `maxIterations`：**必填安全上限**，防止无限循环（默认 10，最大 20）
- `label`（可选）：循环标签
- 每次迭代的结果自动传递到下一次
- 达到上限时发出警告并继续

```javascript
// 迭代直到测试通过
await loop('所有测试通过，没有失败的测试用例', async () => {
  await agent('分析失败的测试，修复代码，然后重新运行所有测试...', 
    { label: '修复并测试' })
}, { maxIterations: 5, label: '测试修复循环' })

// 迭代生成直到质量达标
const report = await loop('报告内容完整且结构清晰，覆盖了所有关键点',
  async () => {
    return agent('根据前一次的反馈改进报告...', { label: '改进报告' })
  },
  { maxIterations: 3 }
)

// 循环内包含多步骤
await loop('所有 lint 错误已修复', async () => {
  const errors = await agent('运行 lint 检查并收集错误...', { label: 'lint检查' })
  await agent(`根据以下 lint 错误修复代码...\n\n${errors}`, { label: '修复lint' })
}, { maxIterations: 5 })
```

### 完整示例：测试通过才部署

```javascript
export const meta = {
  name: 'test-then-deploy',
  phases: [
    { title: '运行测试', detail: '执行测试并检查结果' },
    { title: '修复循环', detail: '如果失败，迭代修复' },
    { title: '部署', detail: '测试全部通过后部署' },
  ],
}

phase('运行测试')
const testResult = await agent('运行项目的所有测试，返回测试结果', 
  { label: '运行测试', phase: '运行测试' })

phase('修复循环')
await loop('all tests pass with 0 failures', async () => {
  await agent('分析上一次的测试失败，修复代码，然后重新运行测试...',
    { label: '修复并测试', phase: '修复循环' })
}, { maxIterations: 5, label: '修复循环' })

phase('部署')
await when('all tests have passed successfully',
  async () => {
    await agent('执行部署流程，推送到生产环境...', 
      { label: '部署', phase: '部署' })
  },
  async () => {
    await agent('测试未通过，生成失败报告并通知开发者...',
      { label: '报告失败', phase: '部署' })
  }
)

return { status: 'done' }
```

## 执行方式

**必须使用 `task` 工具启动 workflow sub-agent**，不要手动逐步模拟执行。

```
task(
  subagent_type: "workflow",
  prompt: "执行 workflow 脚本: .opencode/workflows/<name>.js\n\n请读取该脚本文件，调用 workflow-parse 工具解析执行计划，然后按计划逐步执行。",
  description: "执行 <name> workflow"
)
```

## DSL 语法参考

| 构造 | 语法 | 说明 |
|------|------|------|
| 元信息 | `export const meta = { ... }` | 工作流名称、描述、阶段 |
| 阶段标记 | `phase('阶段名')` | 标记当前执行阶段 |
| 日志 | `log('消息')` | 输出日志信息 |
| Agent 调用 | `await agent('prompt', { label, phase, schema })` | 启动 sub-agent 执行任务 |
| 并行调用 | `await parallel([() => agent(...), ...])` | 多个 agent 并行执行 |
| 动态并行 | `items.map(item => () => agent(...))` | 根据数组动态展开并行 agent |
| **条件判断** | `await when('condition', thenBlock, elseBlock?)` | 条件分支（自然语言条件） |
| **循环迭代** | `await loop('condition', body, { maxIterations, label? })` | 重复执行直到条件满足 |
| 返回结果 | `return { vars }` | 返回最终结果 |

## 安全约束

| 约束 | 值 | 说明 |
|------|-----|------|
| when/loop 嵌套深度 | 3 | 最多嵌套 3 层 |
| loop 最大迭代 | 20 | 硬上限，防止无限循环 |
| loop 默认迭代 | 10 | 未指定 maxIterations 时的默认值 |
| 总步骤上限 | 80 | 展开后所有步骤总数 |
