// ============================================================
// workflow-parse v2 — 解析 workflow JS 脚本，提取结构化执行计划
// v2: 支持 .map() 动态并行组、精确位置排序
// Plugin 版本：导出 createWorkflowTool() 供 plugin index 使用
// ============================================================

import { tool } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { resolve, isAbsolute } from "path"

// ---- Types ----

interface Phase {
  title: string
  detail?: string
}

interface Meta {
  name: string
  description: string
  phases: Phase[]
}

interface AgentCall {
  type: "agent"
  prompt: string
  label: string
  phase?: string
  schemaName?: string
  outputVar?: string
  index: number
  pos: number
}

interface ParallelGroup {
  type: "parallel"
  outputVar?: string
  agents: AgentCall[]
  index: number
  pos: number
}

interface MapParallelGroup {
  type: "mapParallel"
  outputVar?: string
  sourceVar: string
  iterVar: string
  templatePrompt: string
  templateLabel: string
  rawTemplate: string
  schemaName?: string
  phase?: string
  index: number
  pos: number
}

interface PhaseMarker {
  type: "phase"
  title: string
  index: number
  pos: number
}

interface LogMarker {
  type: "log"
  message: string
  index: number
  pos: number
}

interface ReturnStatement {
  type: "return"
  vars: string[]
  index: number
  pos: number
}

type Step = PhaseMarker | LogMarker | AgentCall | ParallelGroup | MapParallelGroup | ReturnStatement

// ---- Helpers ----

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function findBalancedEnd(
  content: string,
  startPos: number,
  open: string,
  close: string
): number {
  let depth = 0
  for (let i = startPos; i < content.length; i++) {
    if (content[i] === open) depth++
    if (content[i] === close) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function findParallelRanges(content: string): [number, number][] {
  const ranges: [number, number][] = []
  const regex = /await\s+parallel\s*\(/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    const end = findBalancedEnd(content, m.index, "(", ")")
    if (end > 0) ranges.push([m.index, end])
  }
  return ranges
}

function extractAgentOptions(content: string, afterBacktickPos: number): string {
  let pos = afterBacktickPos
  while (pos < content.length && /[\s,]/.test(content[pos])) pos++
  if (content[pos] !== "{") return ""
  const endBrace = findBalancedEnd(content, pos, "{", "}")
  if (endBrace < 0) return ""
  return content.slice(pos, endBrace)
}

function parseLabel(optionsRaw: string, fallback: string): string {
  const quotedMatch = optionsRaw.match(/label:\s*['"]([^'"]+)['"]/)
  if (quotedMatch) return quotedMatch[1]
  const tmplMatch = optionsRaw.match(/label:\s*`([^`]+)`/)
  if (tmplMatch) return tmplMatch[1]
  return fallback
}

function parsePhase(optionsRaw: string): string | undefined {
  return optionsRaw.match(/phase:\s*['"`]([^'"`]+)['"`]/)?.[1]
}

function parseSchemaRef(optionsRaw: string): string | undefined {
  return optionsRaw.match(/schema:\s*(\w+)/)?.[1]
}

// ---- Extraction ----

function extractMeta(content: string): Meta | null {
  const metaMatch = content.match(
    /export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/
  )
  if (!metaMatch) return null

  const raw = metaMatch[1]
  const name = raw.match(/name:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? "unnamed"
  const description =
    raw.match(/description:\s*['"`]([\s\S]*?)['"`]\s*[,}]/)?.[1] ?? ""

  const phases: Phase[] = []
  const phaseRegex =
    /\{\s*title:\s*['"`]([^'"`]+)['"`](?:\s*,\s*detail:\s*['"`]([^'"`]+)['"`])?\s*\}/g
  let m: RegExpExecArray | null
  while ((m = phaseRegex.exec(raw)) !== null) {
    phases.push({ title: m[1], detail: m[2] })
  }

  return { name, description, phases }
}

function extractSchemaNames(content: string): Map<string, string> {
  const schemas = new Map<string, string>()
  const schemaRegex =
    /const\s+(\w+)\s*=\s*\{[\s\S]*?type:\s*['"`]object['"`][\s\S]*?\}/g
  let m: RegExpExecArray | null
  while ((m = schemaRegex.exec(content)) !== null) {
    schemas.set(m[1], m[0])
  }
  return schemas
}

function extractPrompt(content: string, searchFrom: number): { prompt: string; endPos: number } | null {
  const char = content[searchFrom]
  if (char === "`") {
    const closePos = content.indexOf("`", searchFrom + 1)
    if (closePos < 0) return null
    return { prompt: content.slice(searchFrom + 1, closePos).trim(), endPos: closePos + 1 }
  } else if (char === "'" || char === '"') {
    const closePos = content.indexOf(char, searchFrom + 1)
    if (closePos < 0) return null
    return { prompt: content.slice(searchFrom + 1, closePos).trim(), endPos: closePos + 1 }
  }
  return null
}

function extractAgentCalls(content: string): AgentCall[] {
  const calls: AgentCall[] = []
  const parallelRanges = findParallelRanges(content)

  function isInParallel(pos: number): boolean {
    return parallelRanges.some(([s, e]) => pos >= s && pos <= e)
  }

  const agentStartRegex = /(?:const\s+(\w+)\s*=\s*)?await\s+agent\s*\(\s*([`'"])/g
  let m: RegExpExecArray | null

  while ((m = agentStartRegex.exec(content)) !== null) {
    if (isInParallel(m.index)) continue

    const outputVar = m[1] || undefined
    const promptStart = m.index + m[0].length - 1
    const extracted = extractPrompt(content, promptStart)
    if (!extracted) continue

    const { prompt, endPos } = extracted
    const optionsRaw = extractAgentOptions(content, endPos)
    const label = parseLabel(optionsRaw, "unnamed")
    const phase = parsePhase(optionsRaw)
    const schemaRef = parseSchemaRef(optionsRaw)

    calls.push({
      type: "agent",
      prompt,
      label,
      phase,
      schemaName: schemaRef,
      outputVar,
      index: 0,
      pos: m.index,
    })
  }

  return calls
}

function matchOutputVar(content: string, beforePos: number): string | undefined {
  const before = content.slice(Math.max(0, beforePos - 200), beforePos)
  // Match destructuring: const [a, b, c] =
  const destructureMatch = before.match(/const\s+\[([^\]]+)\]\s*=\s*$/)
  if (destructureMatch) {
    return `[${destructureMatch[1].trim()}]`
  }
  // Match simple: const foo =
  const simpleMatch = before.match(/const\s+(\w+)\s*=\s*$/)
  if (simpleMatch) {
    return simpleMatch[1]
  }
  return undefined
}

function extractMapParallelGroups(content: string): MapParallelGroup[] {
  const groups: MapParallelGroup[] = []
  const parallelRanges = findParallelRanges(content)

  for (const [start, end] of parallelRanges) {
    const block = content.slice(start, end)

    const mapRegex = /(\w+)\.map\s*\(\s*(\w+)\s*=>\s*\(\s*\)\s*=>\s*agent\s*\(\s*([`'"])/g
    let mm: RegExpExecArray | null

    while ((mm = mapRegex.exec(block)) !== null) {
      const sourceVar = mm[1]
      const iterVar = mm[2]
      const quoteChar = mm[3]

      const promptStart = mm.index + mm[0].length - 1
      const extracted = extractPrompt(block, promptStart)
      if (!extracted) continue

      const { prompt: templatePrompt, endPos } = extracted
      const optionsRaw = extractAgentOptions(block, endPos)
      const templateLabel = parseLabel(optionsRaw, `\${${iterVar}}`)
      const schemaRef = parseSchemaRef(optionsRaw)
      const phase = parsePhase(optionsRaw)

      groups.push({
        type: "mapParallel",
        outputVar: matchOutputVar(content, start),
        sourceVar,
        iterVar,
        templatePrompt,
        templateLabel,
        rawTemplate: block.slice(mm.index, endPos + 50),
        schemaName: schemaRef,
        phase,
        index: 0,
        pos: start,
      })
    }
  }

  return groups
}

function extractStaticParallelGroups(content: string): ParallelGroup[] {
  const groups: ParallelGroup[] = []
  const parallelRanges = findParallelRanges(content)
  const mapGroups = extractMapParallelGroups(content)
  const mapRanges = mapGroups.map(g => g.pos)

  for (const [start, end] of parallelRanges) {
    if (mapRanges.includes(start)) continue

    const block = content.slice(start, end)
    const outputVar = matchOutputVar(content, start)

    const agents: AgentCall[] = []
    const agentStartRegex = /agent\s*\(\s*([`'"])/g
    let am: RegExpExecArray | null

    while ((am = agentStartRegex.exec(block)) !== null) {
      const promptStart = am.index + am[0].length - 1
      const extracted = extractPrompt(block, promptStart)
      if (!extracted) continue

      const { prompt, endPos } = extracted
      const optionsRaw = extractAgentOptions(block, endPos)
      const label = parseLabel(optionsRaw, `Parallel-${agents.length + 1}`)
      const phase = parsePhase(optionsRaw)
      const schemaRef = parseSchemaRef(optionsRaw)

      agents.push({
        type: "agent",
        prompt,
        label,
        phase,
        schemaName: schemaRef,
        index: 0,
        pos: start + am.index,
      })
    }

    if (agents.length > 0) {
      groups.push({
        type: "parallel",
        outputVar,
        agents,
        index: 0,
        pos: start,
      })
    }
  }

  return groups
}

function extractPhases(content: string): PhaseMarker[] {
  const phases: PhaseMarker[] = []
  const regex = /phase\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    phases.push({ type: "phase", title: m[1], index: 0, pos: m.index })
  }
  return phases
}

function extractReturn(content: string): ReturnStatement | null {
  const m = content.match(/return\s*\{\s*([^}]+)\s*\}/)
  if (!m) return null
  const vars = m[1]
    .split(",")
    .map((v) => v.trim().split(":")[0].trim())
    .filter(Boolean)
  return { type: "return", vars, index: 0, pos: m.index ?? 999 }
}

function extractLogs(content: string): LogMarker[] {
  const logs: LogMarker[] = []
  const regex = /log\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(content)) !== null) {
    logs.push({ type: "log", message: m[1], index: 0, pos: m.index })
  }
  return logs
}

function buildOrderedPlan(
  phases: PhaseMarker[],
  logs: LogMarker[],
  agentCalls: AgentCall[],
  staticParallelGroups: ParallelGroup[],
  mapParallelGroups: MapParallelGroup[],
  returnStmt: ReturnStatement | null
): Step[] {
  const steps: Step[] = [
    ...phases,
    ...logs,
    ...agentCalls,
    ...staticParallelGroups,
    ...mapParallelGroups,
  ]
  if (returnStmt) steps.push(returnStmt)

  steps.sort((a, b) => a.pos - b.pos)

  return steps.map((s, i) => {
    s.index = i + 1
    return s
  })
}

// ---- Formatting ----

function formatPlan(
  meta: Meta | null,
  steps: Step[],
  schemas: Map<string, string>
): string {
  const lines: string[] = []

  if (meta) {
    lines.push(`# Workflow: ${meta.name}`)
    lines.push(`**Description**: ${meta.description}`)
    if (meta.phases.length > 0) {
      lines.push(
        `**Phases**: ${meta.phases.map((p) => p.title).join(" → ")}`
      )
    }
    lines.push("")
  }

  lines.push(`## Execution Plan (${steps.length} steps)`)
  lines.push("")

  for (const step of steps) {
    switch (step.type) {
      case "phase":
        lines.push(`### Phase: ${step.title}`)
        lines.push("")
        break

      case "log":
        lines.push(`> ${step.message}`)
        break

      case "agent": {
        const schemaNote = step.schemaName
          ? ` (schema: ${step.schemaName})`
          : ""
        lines.push(
          `**[${step.index}]** agent("${step.label}")${schemaNote} → ${step.outputVar || "(no var)"}`
        )
        lines.push(`  - Prompt: ${step.prompt.slice(0, 150)}${step.prompt.length > 150 ? "..." : ""}`)
        if (step.schemaName && schemas.has(step.schemaName)) {
          lines.push(`  - Schema: ${schemas.get(step.schemaName)}`)
        }
        lines.push("")
        break
      }

      case "parallel": {
        lines.push(
          `**[${step.index}]** parallel(${step.agents.length} agents) → ${step.outputVar || "(no var)"}`
        )
        lines.push(`  Execute ALL agents in parallel (single response, multiple task calls):`)
        for (const a of step.agents) {
          const schemaNote = a.schemaName ? ` (${a.schemaName})` : ""
          lines.push(`    - agent("${a.label}")${schemaNote}`)
        }
        lines.push("")
        break
      }

      case "mapParallel": {
        const schemaNote = step.schemaName
          ? ` (schema: ${step.schemaName})`
          : ""
        lines.push(
          `**[${step.index}]** mapParallel(source: ${step.sourceVar}, iter: ${step.iterVar})${schemaNote} → ${step.outputVar || "(no var)"}`
        )
        lines.push(`  **Dynamic expansion** — expand at runtime from previous result:`)
        lines.push(`  - Source variable: \`${step.sourceVar}\` (array from previous step)`)
        lines.push(`  - Iterator: \`${step.iterVar}\``)
        lines.push(`  - Template label: \`${step.templateLabel}\``)
        lines.push(`  - Template prompt: ${step.templatePrompt.slice(0, 120)}${step.templatePrompt.length > 120 ? "..." : ""}`)
        lines.push("")
        lines.push(`  **Execution**:`)
        lines.push(`  1. Read the result of \`${step.sourceVar}\` step to get the item list`)
        lines.push(`  2. For EACH item, replace \${${step.iterVar}} in template prompt and label`)
        lines.push(`  3. Call ALL expanded agents in parallel (single response, multiple task calls)`)
        lines.push("")
        if (step.schemaName && schemas.has(step.schemaName)) {
          lines.push(`  - Schema: ${schemas.get(step.schemaName)}`)
          lines.push("")
        }
        break
      }

      case "return":
        lines.push(
          `**[END]** return { ${step.vars.join(", ")} }`
        )
        lines.push("")
        break
    }
  }

  lines.push("## Execution Instructions")
  lines.push("1. Execute steps in order (top to bottom)")
  lines.push(
    "2. For `agent()` steps: call task tool with the full prompt from the script"
  )
  lines.push(
    "3. For `parallel()` steps: call task tool for EACH agent **in the same response** (parallel execution)"
  )
  lines.push(
    "4. For `mapParallel()` steps: expand dynamically from previous result, then call ALL agents **in the same response** (parallel execution)"
  )
  lines.push(
    "5. Save each result to the output variable name, use in subsequent prompts"
  )
  lines.push(
    "6. For `return`: pass the specified variables back as the final result"
  )
  lines.push(
    '7. Use subagent_type="explore" for read-only tasks, "general" for write tasks'
  )
  lines.push("")
  lines.push("## Parallel Execution Rules")
  lines.push("- When a step contains multiple agents (parallel or mapParallel), you MUST issue ALL task calls in a SINGLE response")
  lines.push("- This is how OpenCode achieves concurrent execution: multiple tool_use blocks in one response")
  lines.push("- Do NOT wait for one agent to finish before starting the next in a parallel group")

  return lines.join("\n")
}

// ---- Tool Factory ----

export function createWorkflowTool() {
  return tool({
    description:
      "解析 workflow JS 脚本文件，提取结构化执行计划（meta、phases、agent 调用、parallel 分组、mapParallel 动态展开、return）。v2 支持动态 .map() 并行。",
    args: {
      scriptPath: tool.schema
        .string()
        .describe(
          "Workflow JS 脚本路径（相对于项目根目录或绝对路径）"
        ),
    },
    async execute({ scriptPath }, ctx) {
      const absPath = isAbsolute(scriptPath)
        ? scriptPath
        : resolve(ctx.worktree, scriptPath)

      if (!existsSync(absPath)) {
        throw new Error(`Workflow script not found: ${absPath}`)
      }

      const content = readFileSync(absPath, "utf-8")

      const meta = extractMeta(content)
      const schemas = extractSchemaNames(content)
      const phases = extractPhases(content)
      const logs = extractLogs(content)
      const agentCalls = extractAgentCalls(content)
      const mapParallelGroups = extractMapParallelGroups(content)
      const staticParallelGroups = extractStaticParallelGroups(content)
      const returnStmt = extractReturn(content)

      const steps = buildOrderedPlan(
        phases,
        logs,
        agentCalls,
        staticParallelGroups,
        mapParallelGroups,
        returnStmt
      )

      const planText = formatPlan(meta, steps, schemas)

      const mapParallelAgents = mapParallelGroups.length
      const staticParallelAgents = staticParallelGroups.reduce(
        (sum, g) => sum + g.agents.length,
        0
      )

      return {
        title: meta ? `Workflow: ${meta.name}` : "Workflow Plan",
        output: planText,
        metadata: {
          meta,
          totalSteps: steps.length,
          agentCallCount: agentCalls.length,
          staticParallelGroupCount: staticParallelGroups.length,
          staticParallelAgentCount: staticParallelAgents,
          mapParallelGroupCount: mapParallelGroups.length,
          mapParallelSources: mapParallelGroups.map(g => g.sourceVar),
        },
      }
    },
  })
}
