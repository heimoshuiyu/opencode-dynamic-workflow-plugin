# OpenCode Workflow Plugin

An [OpenCode](https://opencode.ai) plugin that enables multi-step workflow orchestration with serial, parallel, and dynamic mapParallel execution. Define workflows as JavaScript DSL scripts, and the plugin dispatches sub-agents to complete complex tasks — with intermediate results isolated from your main conversation.

[中文文档](./README.zh.md)

## Features

- **Serial execution** — Steps run in order, with results chained between agents.
- **Parallel execution** — Multiple agents launched concurrently in a single response, achieving real speedup (4.7x measured).
- **Dynamic mapParallel** — `array.map(item => agent(...))` pattern expands at runtime based on previous results, then runs all agents in parallel.
- **Result isolation** — Intermediate outputs stay in the workflow agent's context, keeping your main conversation clean.
- **Correct session tree** — All sub-agents nest properly in the TUI session tree.

## How It Works

The plugin registers two components via OpenCode's plugin hooks:

| Component | Hook | Description |
|-----------|------|-------------|
| `workflow` agent | `Hooks.config` | A subagent that reads workflow scripts, parses them, and dispatches sub-agents step by step. |
| `workflow-parse` tool | `Hooks.tool` | Parses workflow JS scripts into structured execution plans (phases, agents, parallel groups, mapParallel expansions). |

### Execution Flow

```
User → Main Agent → task("workflow") → Workflow Agent
                                        ├── task("explore") → Sub-agent A
                                        ├── task("explore") → Sub-agent B  ← parallel
                                        ├── task("explore") → Sub-agent C  ← parallel
                                        └── task("general") → Sub-agent D
                                        Final result → returned to Main Agent
```

## Setup

Add the plugin to your [OpenCode config](https://opencode.ai/docs/config/):

### Global config (`~/.config/opencode/opencode.json`)

```json
{
  "plugin": ["/home/hmsy/opencode-workflow-plugin"]
}
```

Or use a relative path to a local directory. OpenCode will auto-load the plugin on next run.

## Workflow Script Format

Place workflow scripts in `.opencode/workflows/` in your project root:

```javascript
export const meta = {
  name: 'my-workflow',
  description: 'What this workflow does',
  phases: [
    { title: 'Phase 1', detail: 'Description' },
    { title: 'Phase 2', detail: 'Description' },
  ],
}

// Schema for structured output (optional)
const MY_SCHEMA = {
  type: 'object',
  properties: {
    field1: { type: 'string', description: 'Description' },
  },
}

// Phase marker
phase('Phase 1')

// Log message
log('Starting analysis...')

// Single agent call
const result = await agent(`Analyze the project structure...`, {
  label: 'Analyze structure',
  phase: 'Phase 1',
  schema: MY_SCHEMA,
})

// Parallel execution (static)
const results = await parallel([
  () => agent(`Analyze A...`, { label: 'A' }),
  () => agent(`Analyze B...`, { label: 'B' }),
])

// Dynamic parallel expansion (mapParallel)
const items = ['project-a', 'project-b', 'project-c']
const analyses = await parallel(
  items.map(item => () => agent(`Analyze ${item}...`, { label: `Analyze:${item}` }))
)

// Return final result
return { result, analyses }
```

## Running a Workflow

Tell OpenCode:

```
Run the understand-project workflow
```

Or manually via the `task` tool:

```
task(
  subagent_type: "workflow",
  prompt: "Execute workflow script: .opencode/workflows/understand-project.js",
  description: "Run understand-project workflow"
)
```

## Example: understand-project.js

The plugin includes an example workflow that comprehensively analyzes a project:

| Phase | Agents | Type |
|-------|--------|------|
| Explore structure | 2 agents | Serial |
| Analyze docs | 1 agent | Serial |
| Sub-project research | N agents | mapParallel |
| Synthesize report | 1 agent | Serial |

Tested with 9 parallel sub-project agents — **4.7x speedup** (67s parallel vs 319s serial).

## Plugin Architecture

```
opencode-workflow-plugin/
├── package.json
├── src/
│   ├── index.ts                  # Plugin entry — server() → Hooks
│   ├── workflow-agent-prompt.ts  # Workflow agent system prompt
│   └── workflow-parse-tool.ts    # Script parser (phases, agents, parallel, mapParallel)
├── workflows/
│   └── understand-project.js     # Example workflow script
└── skill/
    └── SKILL.md                  # Skill documentation
```

## License

MIT
