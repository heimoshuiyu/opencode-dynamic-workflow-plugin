# OpenCode Workflow 插件

> ⚠️ **须知**
>
> 这本质上是一个 **vibe code** 项目。它通过逆向 Claude Code 的 *dynamic workspace* 功能，在 [OpenCode](https://opencode.ai) 中实现了类似的能力，但细节上仍有差异。例如，工作流中的节点是用子代理（sub-agent）实现的，子代理可能输出不完全符合预期的结构化输出。但由于整个工作流的输入输出都直接交给 agents 处理，所以在实践中这不是什么大问题——反而换来了更高的灵活性。
>
> **前置条件**：使用本插件前，你**必须**开启 OpenCode 的实验性环境变量，允许子代理嵌套运行。在启动 OpenCode 前设置 `OPENCODE_EXPERIMENTAL_NESTED_SUBAGENTS=1`。

一个 [OpenCode](https://opencode.ai) 插件，提供多步骤工作流编排能力，支持串行、并行、动态 mapParallel、条件判断（`when`）和循环迭代（`loop`）。将工作流定义为 JavaScript DSL 脚本，插件会调度子代理完成复杂任务——中间结果与主对话完全隔离。

## 功能

- **串行执行** — 步骤按顺序运行，结果在代理之间传递。
- **并行执行** — 多个代理在单次响应中并发启动，实测 **4.7 倍加速**。
- **动态 mapParallel** — `array.map(item => agent(...))` 模式根据前一步结果在运行时展开，然后并行执行所有代理。
- **条件判断（`when`）** — `when(condition, then, else?)` 在运行时评估自然语言条件，选择执行路径。
- **循环迭代（`loop`）** — `loop(condition, body, { maxIterations })` 重复执行步骤直到满足退出条件（如所有测试通过）。
- **递归嵌套** — `when` 和 `loop` 最多嵌套 3 层，每层内完整解析子步骤。
- **结果隔离** — 中间结果留在工作流代理的上下文中，不污染主对话。
- **会话树正确** — 所有子代理在 TUI 会话树中正确嵌套。

## 工作原理

插件通过 OpenCode 的插件钩子注册两个组件：

| 组件 | 钩子 | 说明 |
|------|------|------|
| `workflow` 代理 | `Hooks.config` | 子代理，读取工作流脚本、解析并逐步调度子代理执行。 |
| `workflow-parse` 工具 | `Hooks.tool` | 解析工作流 JS 脚本为结构化执行计划（阶段、代理、并行组、mapParallel 展开、when 条件、loop 循环）。 |

### 执行流程

```
用户 → 主代理 → task("workflow") → 工作流代理
                                    ├── task("explore") → 子代理 A
                                    ├── task("explore") → 子代理 B  ← 并行
                                    ├── task("explore") → 子代理 C  ← 并行
                                    └── task("general") → 子代理 D
                                    最终结果 → 返回主代理
```

## 安装

在 [OpenCode 配置文件](https://opencode.ai/docs/config/) 中添加插件：

### 全局配置（`~/.config/opencode/opencode.json`）

```json
{
  "plugin": ["/home/hmsy/opencode-dynamic-workflow-plugin"]
}
```

也可以使用指向本地目录的相对路径。OpenCode 会在下次运行时自动加载插件。

## 工作流脚本格式

将工作流脚本放在项目根目录的 `.opencode/workflows/` 目录下：

```javascript
export const meta = {
  name: 'my-workflow',
  description: '这个工作流做什么',
  phases: [
    { title: '阶段一', detail: '描述' },
    { title: '阶段二', detail: '描述' },
  ],
}

// 结构化输出的 Schema（可选）
const MY_SCHEMA = {
  type: 'object',
  properties: {
    field1: { type: 'string', description: '说明' },
  },
}

// 阶段标记
phase('阶段一')

// 日志
log('开始分析...')

// 单个代理调用
const result = await agent(`分析项目结构...`, {
  label: '分析结构',
  phase: '阶段一',
  schema: MY_SCHEMA,
})

// 并行执行（静态）
const results = await parallel([
  () => agent(`分析 A...`, { label: 'A' }),
  () => agent(`分析 B...`, { label: 'B' }),
])

// 动态并行展开（mapParallel）
const items = ['project-a', 'project-b', 'project-c']
const analyses = await parallel(
  items.map(item => () => agent(`分析 ${item}...`, { label: `分析:${item}` }))
)

// 条件判断（when）
await when('分析结果中发现了安全漏洞', async () => {
  await agent(`生成安全修复计划...`, { label: '安全修复' })
})

// if-else 条件
await when('质量评分高于 80 分',
  async () => {
    await agent(`准备部署...`, { label: '部署' })
  },
  async () => {
    await agent(`生成改进建议...`, { label: '改进建议' })
  }
)

// 循环迭代（直到条件满足）
await loop('所有测试通过，0 个失败', async () => {
  await agent(`分析失败测试并修复代码，然后重新运行测试...`, 
    { label: '修复并测试' })
}, { maxIterations: 5, label: '测试修复循环' })

// 返回最终结果
return { result, analyses }
```

## 运行工作流

告诉 OpenCode：

```
运行 understand-project workflow
```

或通过 `task` 工具手动调用：

```
task(
  subagent_type: "workflow",
  prompt: "执行 workflow 脚本: .opencode/workflows/understand-project.js",
  description: "运行 understand-project 工作流"
)
```

## 示例：understand-project.js

插件附带一个示例工作流，用于全面分析项目：

| 阶段 | 代理数 | 类型 |
|------|--------|------|
| 探索结构 | 2 个代理 | 串行 |
| 分析文档 | 1 个代理 | 串行 |
| 子项目调研 | N 个代理 | mapParallel |
| 综合报告 | 1 个代理 | 串行 |

实测 9 个并行子项目代理——**4.7 倍加速**（并行 67 秒 vs 串行 319 秒）。

## 插件结构

```
opencode-dynamic-workflow-plugin/
├── package.json
├── src/
│   ├── index.ts                  # 插件入口 — server() → Hooks
│   ├── workflow-agent-prompt.ts  # 工作流代理系统提示词
│   └── workflow-parse-tool.ts    # 脚本解析器（阶段、代理、并行、mapParallel、when、loop）
├── workflows/
│   └── understand-project.js     # 示例工作流脚本
└── skill/
    └── SKILL.md                  # Skill 文档
```

## 许可证

MIT
