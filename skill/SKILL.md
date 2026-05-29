---
name: workflow
description: "执行多步骤 workflow 脚本，支持串行、并行、动态 mapParallel。当用户想要运行复杂的多阶段任务、编排多个 sub-agent 并行/串行工作、或使用预定义的 workflow 脚本时触发。关键词：workflow、工作流、编排、多步骤、并行分析。"
---

# Workflow 执行 Skill

> 由 `opencode-workflow-plugin` 提供。

## ⚠️ 核心原则：先编排，再执行

当用户提出一个复杂的多步骤任务时，必须遵循以下流程：

### 第一步：编排 Workflow

在了解清楚任务的全貌后，**先编写 workflow 脚本**，放到 `.opencode/workflows/` 目录下。

脚本中只需要描述：
- **每个阶段的条件**：该阶段在什么前提下执行
- **先后顺序**：哪些步骤串行、哪些步骤并行
- **参考内容**：每个 sub-agent 应该参考哪些文件、目录或前序结果
- **验收条件**：每个阶段的产出应该满足什么标准

**脚本中不需要包含**：实际任务的详细代码、具体的实现逻辑、逐行的代码分析等。这些由 sub-agent 在执行时自行处理。

```javascript
// ✅ 好的 workflow 脚本：只描述编排逻辑
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
  schema: DIFF_SCHEMA,  // 只定义输出结构
})

phase('并行审查')
const [security, style, perf] = await parallel([
  () => agent(`基于以下 diff，从安全角度审查代码，找出潜在漏洞和风险。验收标准：列出所有安全问题及严重等级。\n\nDiff:\n${diff}`, { label: '安全审查' }),
  () => agent(`基于以下 diff，从代码风格角度审查，找出命名、结构、可读性问题。验收标准：列出所有风格问题及改进建议。\n\nDiff:\n${diff}`, { label: '风格审查' }),
  () => agent(`基于以下 diff，从性能角度审查，找出潜在的性能瓶颈。验收标准：列出所有性能问题及优化方案。\n\nDiff:\n${diff}`, { label: '性能审查' }),
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
- **并行加速**：多个独立任务在同一 response 中以多个 task calls 并发发出，实测 **4.7 倍加速**（9 个并行 agent：67s vs 串行 319s）。这是 workflow 最核心的价值——把多个互不依赖的分析任务并行化，大幅缩短总耗时。
- **编排能力**：通过脚本精确控制哪些步骤串行（有依赖）、哪些步骤并行（无依赖），先扫描再深入、先分析再综合，逻辑清晰。
- **动态扩展**：`mapParallel` 模式根据运行时数据（如前一步发现的子目录列表）动态展开并行 agent，不需要预先知道有多少任务。
- **结果隔离**：中间结果留在 workflow agent 上下文中，不污染主对话。
- **会话树正确**：所有 sub-agent 正确嵌套在 TUI 中。

## Workflow 脚本格式

脚本放在 `.opencode/workflows/` 目录下，使用 JS DSL 编写。

**脚本定位**：workflow 脚本是「编排文档」，不是「实现代码」。它描述的是任务的**结构**（谁先谁后、谁并行谁串行），而不是**细节**（具体怎么分析代码、怎么写报告）。详细的工作交给 sub-agent 去做。

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

// 最终返回
return { result, analyses }
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

workflow agent 会自动：解析脚本 → 按步骤调度 sub-agent → 并行执行 → 返回最终结果。

## 核心能力

### 并行执行（`parallel()`）

多个互不依赖的 agent 在同一 response 中并发发出，OpenCode 同时执行。适合：
- 同时分析多个子项目 / 多个模块
- 同时检查代码的多个维度（安全、风格、性能）
- 同时阅读多份文档

### 动态并行（`mapParallel()`）

根据运行时数据动态展开并行 agent。比如先用一个 agent 扫描出所有子目录，然后对每个子目录并行启动分析 agent。不需要预先知道有多少项。

### 串行编排

有依赖关系的步骤按顺序执行，前一步的结果传递给后一步的 prompt。比如：
1. 先扫描项目结构 → 结果传给下一步
2. 再分析核心文档 → 结果传给下一步
3. 最后综合所有结果生成报告

串行保证依赖正确，并行最大化吞吐，脚本精确控制两者。
