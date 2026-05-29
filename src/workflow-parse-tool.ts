// ============================================================
// workflow-parse v3 — 解析 workflow JS 脚本，提取结构化执行计划
// v3: 支持 when(条件判断)、loop(循环)、递归解析嵌套结构
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

interface WhenStep {
  type: "when"
  condition: string
  thenSteps: Step[]
  elseSteps?: Step[]
  outputVar?: string
  index: number
  pos: number
}

interface LoopStep {
  type: "loop"
  condition: string
  body: Step[]
  maxIterations: number
  label?: string
  outputVar?: string
  index: number
  pos: number
}

type Step =
  | PhaseMarker
  | LogMarker
  | AgentCall
  | ParallelGroup
  | MapParallelGroup
  | ReturnStatement
  | WhenStep
  | LoopStep

// Internal types for block extraction (before recursive parsing)

interface WhenBlock {
  condition: string
  thenContent: string
  thenRange: [number, number]
  elseContent?: string
  elseRange?: [number, number]
  outputVar?: string
  pos: number
}

interface LoopBlock {
  condition: string
  bodyContent: string
  bodyRange: [number, number]
  maxIterations: number
  label?: string
  outputVar?: string
  pos: number
}

// ---- Constants ----

const MAX_NESTING_DEPTH = 3
const DEFAULT_MAX_ITERATIONS = 10
const HARD_MAX_ITERATIONS = 20
const MAX_TOTAL_STEPS = 80

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

function matchOutputVar(content: string, beforePos: number): string | undefined {
  const before = content.slice(Math.max(0, beforePos - 200), beforePos)
  const destructureMatch = before.match(/const\s+\[([^\]]+)\]\s*=\s*$/)
  if (destructureMatch) {
    return `[${destructureMatch[1].trim()}]`
  }
  const simpleMatch = before.match(/const\s+(\w+)\s*=\s*$/)
  if (simpleMatch) {
    return simpleMatch[1]
  }
  return undefined
}

// ---- Arrow Function Body Finder ----

function findArrowFunctionBody(
  content: string,
  startPos: number
): { bodyStart: number; bodyEnd: number; rangeStart: number; rangeEnd: number } | null {
  let pos = startPos

  // Optional "async"
  if (content.slice(pos, pos + 5) === "async") pos += 5
  while (pos < content.length && /\s/.test(content[pos])) pos++

  // "("
  if (content[pos] !== "(") return null
  const parenEnd = findBalancedEnd(content, pos, "(", ")")
  if (parenEnd < 0) return null
  pos = parenEnd
  while (pos < content.length && /\s/.test(content[pos])) pos++

  // "=>"
  if (content.slice(pos, pos + 2) !== "=>") return null
  pos += 2
  while (pos < content.length && /\s/.test(content[pos])) pos++

  // "{" (block body)
  if (content[pos] !== "{") return null
  const bodyEnd = findBalancedEnd(content, pos, "{", "}")
  if (bodyEnd < 0) return null

  return {
    bodyStart: pos + 1, // after {
    bodyEnd: bodyEnd - 1, // before }
    rangeStart: startPos,
    rangeEnd: bodyEnd,
  }
}

// ---- Extraction: Flat Steps (existing types) ----

function extractMeta(content: string): Meta | null {
  const metaMatch = content.match(/export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/)
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

function extractPrompt(
  content: string,
  searchFrom: number
): { prompt: string; endPos: number } | null {
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

  const agentStartRegex =
    /(?:const\s+(\w+)\s*=\s*)?await\s+agent\s*\(\s*([`'"])/g
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

function extractMapParallelGroups(content: string): MapParallelGroup[] {
  const groups: MapParallelGroup[] = []
  const parallelRanges = findParallelRanges(content)

  for (const [start, end] of parallelRanges) {
    const block = content.slice(start, end)

    const mapRegex =
      /(\w+)\.map\s*\(\s*(\w+)\s*=>\s*\(\s*\)\s*=>\s*agent\s*\(\s*([`'"])/g
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
  const mapRanges = mapGroups.map((g) => g.pos)

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

// ---- Extraction: when / loop blocks ----

function findWhenBlocks(content: string): WhenBlock[] {
  const blocks: WhenBlock[] = []
  const regex = /(?:const\s+(\w+)\s*=\s*)?await\s+when\s*\(/g
  let m: RegExpExecArray | null

  while ((m = regex.exec(content)) !== null) {
    const outputVar = m[1] || undefined
    const blockStart = m.index
    let pos = m.index + m[0].length

    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) pos++

    // Extract condition string
    const condResult = extractPrompt(content, pos)
    if (!condResult) continue
    const condition = condResult.prompt
    pos = condResult.endPos

    // Skip whitespace and comma
    while (pos < content.length && /[\s,]/.test(content[pos])) pos++

    // Find then block: async () => { ... } or () => { ... }
    const thenResult = findArrowFunctionBody(content, pos)
    if (!thenResult) continue

    const thenContent = content.slice(thenResult.bodyStart, thenResult.bodyEnd)
    const thenRange: [number, number] = [thenResult.rangeStart, thenResult.rangeEnd]

    pos = thenResult.rangeEnd

    // Try to find else block
    let elseContent: string | undefined
    let elseRange: [number, number] | undefined

    let elsePos = pos
    while (elsePos < content.length && /[\s,]/.test(content[elsePos])) elsePos++

    const elseResult = findArrowFunctionBody(content, elsePos)
    if (elseResult) {
      elseContent = content.slice(elseResult.bodyStart, elseResult.bodyEnd)
      elseRange = [elseResult.rangeStart, elseResult.rangeEnd]
    }

    blocks.push({
      condition,
      thenContent,
      thenRange,
      elseContent,
      elseRange,
      outputVar,
      pos: blockStart,
    })
  }

  return blocks
}

function findLoopBlocks(content: string): LoopBlock[] {
  const blocks: LoopBlock[] = []
  const regex = /(?:const\s+(\w+)\s*=\s*)?await\s+loop\s*\(/g
  let m: RegExpExecArray | null

  while ((m = regex.exec(content)) !== null) {
    const outputVar = m[1] || undefined
    const blockStart = m.index
    let pos = m.index + m[0].length

    // Skip whitespace
    while (pos < content.length && /\s/.test(content[pos])) pos++

    // Extract condition string
    const condResult = extractPrompt(content, pos)
    if (!condResult) continue
    const condition = condResult.prompt
    pos = condResult.endPos

    // Skip whitespace and comma
    while (pos < content.length && /[\s,]/.test(content[pos])) pos++

    // Find body: async () => { ... } or () => { ... }
    const bodyResult = findArrowFunctionBody(content, pos)
    if (!bodyResult) continue

    const bodyContent = content.slice(bodyResult.bodyStart, bodyResult.bodyEnd)
    const bodyRange: [number, number] = [bodyResult.rangeStart, bodyResult.rangeEnd]

    pos = bodyResult.rangeEnd

    // Try to find options object: { maxIterations: 5, label: 'xxx' }
    let maxIterations = DEFAULT_MAX_ITERATIONS
    let label: string | undefined

    while (pos < content.length && /[\s,]/.test(content[pos])) pos++

    if (content[pos] === "{") {
      const optionsEnd = findBalancedEnd(content, pos, "{", "}")
      if (optionsEnd > 0) {
        const optionsRaw = content.slice(pos, optionsEnd)
        const maxMatch = optionsRaw.match(/maxIterations:\s*(\d+)/)
        if (maxMatch) {
          maxIterations = Math.min(parseInt(maxMatch[1]), HARD_MAX_ITERATIONS)
        }
        const labelMatch = optionsRaw.match(/label:\s*['"`]([^'"`]+)['"`]/)
        if (labelMatch) {
          label = labelMatch[1]
        }
      }
    }

    blocks.push({
      condition,
      bodyContent,
      bodyRange,
      maxIterations,
      label,
      outputVar,
      pos: blockStart,
    })
  }

  return blocks
}

// ---- Recursive Extraction Engine ----

function extractFlatSteps(content: string, excludedRanges: [number, number][]): Step[] {
  function isExcluded(pos: number): boolean {
    return excludedRanges.some(([s, e]) => pos >= s && pos <= e)
  }

  const phases = extractPhases(content).filter((s) => !isExcluded(s.pos))
  const logs = extractLogs(content).filter((s) => !isExcluded(s.pos))
  const agentCalls = extractAgentCalls(content).filter((s) => !isExcluded(s.pos))
  const mapParallelGroups = extractMapParallelGroups(content).filter(
    (s) => !isExcluded(s.pos)
  )
  const staticParallelGroups = extractStaticParallelGroups(content).filter(
    (s) => !isExcluded(s.pos)
  )
  const returnStmt = extractReturn(content)

  const steps: Step[] = [
    ...phases,
    ...logs,
    ...agentCalls,
    ...staticParallelGroups,
    ...mapParallelGroups,
  ]
  if (returnStmt && !isExcluded(returnStmt.pos)) steps.push(returnStmt)

  steps.sort((a, b) => a.pos - b.pos)
  return steps
}

function extractAllStepsRecursive(content: string, depth: number = 0): Step[] {
  if (depth > MAX_NESTING_DEPTH) return []

  // Find all when/loop blocks in this scope
  const whenBlocks = findWhenBlocks(content)
  const loopBlocks = findLoopBlocks(content)

  // Collect ALL body ranges (including nested blocks)
  const allBodyRanges: [number, number][] = []
  for (const wb of whenBlocks) {
    allBodyRanges.push(wb.thenRange)
    if (wb.elseRange) allBodyRanges.push(wb.elseRange)
  }
  for (const lb of loopBlocks) {
    allBodyRanges.push(lb.bodyRange)
  }

  // Keep only top-level when/loop blocks (filter out nested ones)
  const topLevelWhenBlocks = whenBlocks.filter(
    (wb) => !allBodyRanges.some(([s, e]) => wb.pos > s && wb.pos < e)
  )
  const topLevelLoopBlocks = loopBlocks.filter(
    (lb) => !allBodyRanges.some(([s, e]) => lb.pos > s && lb.pos < e)
  )

  // Compute excluded ranges for flat step extraction (top-level blocks only)
  const excludedRanges: [number, number][] = []
  for (const wb of topLevelWhenBlocks) {
    excludedRanges.push(wb.thenRange)
    if (wb.elseRange) excludedRanges.push(wb.elseRange)
  }
  for (const lb of topLevelLoopBlocks) {
    excludedRanges.push(lb.bodyRange)
  }

  // Extract flat steps, excluding when/loop body ranges
  const flatSteps = extractFlatSteps(content, excludedRanges)

  // Build when steps with recursive sub-steps
  const whenSteps: WhenStep[] = topLevelWhenBlocks.map((wb) => ({
    type: "when" as const,
    condition: wb.condition,
    thenSteps: extractAllStepsRecursive(wb.thenContent, depth + 1),
    elseSteps: wb.elseContent
      ? extractAllStepsRecursive(wb.elseContent, depth + 1)
      : undefined,
    outputVar: wb.outputVar,
    index: 0,
    pos: wb.pos,
  }))

  // Build loop steps with recursive sub-steps
  const loopSteps: LoopStep[] = topLevelLoopBlocks.map((lb) => ({
    type: "loop" as const,
    condition: lb.condition,
    body: extractAllStepsRecursive(lb.bodyContent, depth + 1),
    maxIterations: lb.maxIterations,
    label: lb.label,
    outputVar: lb.outputVar,
    index: 0,
    pos: lb.pos,
  }))

  // Combine all steps and sort by position
  const allSteps: Step[] = [...flatSteps, ...whenSteps, ...loopSteps]
  allSteps.sort((a, b) => a.pos - b.pos)

  return allSteps
}

// ---- Step Numbering & Counting ----

function numberStepsRecursive(steps: Step[], counter: { value: number }): void {
  for (const s of steps) {
    counter.value++
    s.index = counter.value
    if (s.type === "when") {
      numberStepsRecursive(s.thenSteps, counter)
      if (s.elseSteps) numberStepsRecursive(s.elseSteps, counter)
    } else if (s.type === "loop") {
      numberStepsRecursive(s.body, counter)
    }
  }
}

interface StepCounts {
  total: number
  agents: number
  parallelGroups: number
  mapParallelGroups: number
  whenSteps: number
  loopSteps: number
}

function countStepsRecursive(steps: Step[]): StepCounts {
  const counts: StepCounts = {
    total: 0,
    agents: 0,
    parallelGroups: 0,
    mapParallelGroups: 0,
    whenSteps: 0,
    loopSteps: 0,
  }

  for (const s of steps) {
    counts.total++
    switch (s.type) {
      case "agent":
        counts.agents++
        break
      case "parallel":
        counts.parallelGroups++
        break
      case "mapParallel":
        counts.mapParallelGroups++
        break
      case "when": {
        counts.whenSteps++
        const thenCounts = countStepsRecursive(s.thenSteps)
        counts.total += thenCounts.total
        counts.agents += thenCounts.agents
        counts.parallelGroups += thenCounts.parallelGroups
        counts.mapParallelGroups += thenCounts.mapParallelGroups
        counts.whenSteps += thenCounts.whenSteps
        counts.loopSteps += thenCounts.loopSteps
        if (s.elseSteps) {
          const elseCounts = countStepsRecursive(s.elseSteps)
          counts.total += elseCounts.total
          counts.agents += elseCounts.agents
          counts.parallelGroups += elseCounts.parallelGroups
          counts.mapParallelGroups += elseCounts.mapParallelGroups
          counts.whenSteps += elseCounts.whenSteps
          counts.loopSteps += elseCounts.loopSteps
        }
        break
      }
      case "loop": {
        counts.loopSteps++
        const bodyCounts = countStepsRecursive(s.body)
        counts.total += bodyCounts.total
        counts.agents += bodyCounts.agents
        counts.parallelGroups += bodyCounts.parallelGroups
        counts.mapParallelGroups += bodyCounts.mapParallelGroups
        counts.whenSteps += bodyCounts.whenSteps
        counts.loopSteps += bodyCounts.loopSteps
        break
      }
    }
  }

  return counts
}

// ---- Formatting ----

function formatSteps(
  steps: Step[],
  lines: string[],
  schemas: Map<string, string>,
  counter: { value: number },
  indent: number
): void {
  const prefix = "  ".repeat(indent)

  for (const step of steps) {
    switch (step.type) {
      case "phase":
        lines.push(`${prefix}### Phase: ${step.title}`)
        lines.push("")
        break

      case "log":
        lines.push(`${prefix}> ${step.message}`)
        break

      case "agent": {
        counter.value++
        const schemaNote = step.schemaName
          ? ` (schema: ${step.schemaName})`
          : ""
        lines.push(
          `${prefix}**[${counter.value}]** agent("${step.label}")${schemaNote} → ${step.outputVar || "(no var)"}`
        )
        lines.push(
          `${prefix}  - Prompt: ${step.prompt.slice(0, 150)}${step.prompt.length > 150 ? "..." : ""}`
        )
        if (step.schemaName && schemas.has(step.schemaName)) {
          lines.push(`${prefix}  - Schema: ${schemas.get(step.schemaName)}`)
        }
        lines.push("")
        break
      }

      case "parallel": {
        counter.value++
        lines.push(
          `${prefix}**[${counter.value}]** parallel(${step.agents.length} agents) → ${step.outputVar || "(no var)"}`
        )
        lines.push(
          `${prefix}  Execute ALL agents in parallel (single response, multiple task calls):`
        )
        for (const a of step.agents) {
          const schemaNote = a.schemaName ? ` (${a.schemaName})` : ""
          lines.push(`${prefix}    - agent("${a.label}")${schemaNote}`)
        }
        lines.push("")
        break
      }

      case "mapParallel": {
        counter.value++
        const schemaNote = step.schemaName
          ? ` (schema: ${step.schemaName})`
          : ""
        lines.push(
          `${prefix}**[${counter.value}]** mapParallel(source: ${step.sourceVar}, iter: ${step.iterVar})${schemaNote} → ${step.outputVar || "(no var)"}`
        )
        lines.push(
          `${prefix}  **Dynamic expansion** — expand at runtime from previous result:`
        )
        lines.push(
          `${prefix}  - Source variable: \`${step.sourceVar}\` (array from previous step)`
        )
        lines.push(`${prefix}  - Iterator: \`${step.iterVar}\``)
        lines.push(`${prefix}  - Template label: \`${step.templateLabel}\``)
        lines.push(
          `${prefix}  - Template prompt: ${step.templatePrompt.slice(0, 120)}${step.templatePrompt.length > 120 ? "..." : ""}`
        )
        lines.push("")
        lines.push(`${prefix}  **Execution**:`)
        lines.push(
          `${prefix}  1. Read the result of \`${step.sourceVar}\` step to get the item list`
        )
        lines.push(
          `${prefix}  2. For EACH item, replace \${${step.iterVar}} in template prompt and label`
        )
        lines.push(
          `${prefix}  3. Call ALL expanded agents in parallel (single response, multiple task calls)`
        )
        lines.push("")
        if (step.schemaName && schemas.has(step.schemaName)) {
          lines.push(`${prefix}  - Schema: ${schemas.get(step.schemaName)}`)
          lines.push("")
        }
        break
      }

      case "when": {
        counter.value++
        const condPreview =
          step.condition.length > 80
            ? step.condition.slice(0, 80) + "..."
            : step.condition
        lines.push(
          `${prefix}**[${counter.value}]** when("${condPreview}") → ${step.outputVar || "(no var)"}`
        )
        lines.push(
          `${prefix}  **Condition** (evaluated at runtime by LLM): "${condPreview}"`
        )
        lines.push(`${prefix}  ├── [True Branch]`)
        formatSteps(step.thenSteps, lines, schemas, counter, indent + 2)
        if (step.elseSteps && step.elseSteps.length > 0) {
          lines.push(`${prefix}  └── [False Branch]`)
          formatSteps(step.elseSteps, lines, schemas, counter, indent + 2)
        } else {
          lines.push(`${prefix}  └── [False Branch] (skip)`)
        }
        lines.push("")
        break
      }

      case "loop": {
        counter.value++
        const condPreview =
          step.condition.length > 80
            ? step.condition.slice(0, 80) + "..."
            : step.condition
        lines.push(
          `${prefix}**[${counter.value}]** loop("${condPreview}", maxIterations=${step.maxIterations})${step.label ? ` label="${step.label}"` : ""} → ${step.outputVar || "(no var)"}`
        )
        lines.push(
          `${prefix}  **Exit condition** (evaluated after each iteration): "${condPreview}"`
        )
        lines.push(`${prefix}  **Max iterations**: ${step.maxIterations}`)
        lines.push(`${prefix}  └── [Loop Body]`)
        formatSteps(step.body, lines, schemas, counter, indent + 2)
        lines.push("")
        break
      }

      case "return": {
        lines.push(`${prefix}**[END]** return { ${step.vars.join(", ")} }`)
        lines.push("")
        break
      }
    }
  }
}

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
      lines.push(`**Phases**: ${meta.phases.map((p) => p.title).join(" → ")}`)
    }
    lines.push("")
  }

  const counts = countStepsRecursive(steps)
  lines.push(`## Execution Plan (${counts.total} steps)`)
  lines.push("")

  const counter = { value: 0 }
  formatSteps(steps, lines, schemas, counter, 0)

  lines.push("## Execution Instructions")
  lines.push("1. Execute steps in order (top to bottom)")
  lines.push(
    '2. For `agent()` steps: call task tool with the full prompt from the script'
  )
  lines.push(
    '3. For `parallel()` steps: call task tool for EACH agent **in the same response** (parallel execution)'
  )
  lines.push(
    '4. For `mapParallel()` steps: expand dynamically from previous result, then call ALL agents **in the same response** (parallel execution)'
  )
  lines.push(
    '5. For `when(condition, thenSteps, elseSteps?)` steps:'
  )
  lines.push(
    "    - Evaluate the natural language condition against all previous step results"
  )
  lines.push(
    "    - If TRUE: execute thenSteps sequentially"
  )
  lines.push(
    "    - If FALSE: execute elseSteps (if any) or skip"
  )
  lines.push(
    '6. For `loop(condition, body, { maxIterations })` steps:'
  )
  lines.push(
    "    - Execute body steps sequentially"
  )
  lines.push(
    "    - After each iteration, evaluate the exit condition"
  )
  lines.push(
    "    - If condition is TRUE → exit loop with last result"
  )
  lines.push(
    "    - If FALSE and iterations < maxIterations → repeat body (include previous iteration context)"
  )
  lines.push(
    "    - If maxIterations reached → exit with warning"
  )
  lines.push(
    "7. Save each result to the output variable name, use in subsequent prompts"
  )
  lines.push(
    '8. For `return`: pass the specified variables back as the final result'
  )
  lines.push(
    '9. Use subagent_type="explore" for read-only tasks, "general" for write tasks'
  )
  lines.push("")
  lines.push("## Parallel Execution Rules")
  lines.push(
    "- When a step contains multiple agents (parallel or mapParallel), you MUST issue ALL task calls in a SINGLE response"
  )
  lines.push(
    "- This is how OpenCode achieves concurrent execution: multiple tool_use blocks in one response"
  )
  lines.push(
    "- Do NOT wait for one agent to finish before starting the next in a parallel group"
  )
  lines.push("")
  lines.push("## Safety Constraints")
  lines.push(`- Maximum nesting depth: ${MAX_NESTING_DEPTH} levels`)
  lines.push(`- Loop maximum iterations: ${HARD_MAX_ITERATIONS} (default: ${DEFAULT_MAX_ITERATIONS})`)
  lines.push(`- Maximum total steps: ${MAX_TOTAL_STEPS}`)

  return lines.join("\n")
}

// ---- Tool Factory ----

export function createWorkflowTool() {
  return tool({
    description:
      "解析 workflow JS 脚本文件，提取结构化执行计划（meta、phases、agent 调用、parallel 分组、mapParallel 动态展开、when 条件判断、loop 循环、return）。v3 支持条件分支和循环。",
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

      // Recursive extraction with when/loop support
      const steps = extractAllStepsRecursive(content)

      // Number all steps globally
      const counter = { value: 0 }
      numberStepsRecursive(steps, counter)

      // Count step types
      const counts = countStepsRecursive(steps)

      const planText = formatPlan(meta, steps, schemas)

      return {
        title: meta ? `Workflow: ${meta.name}` : "Workflow Plan",
        output: planText,
        metadata: {
          meta,
          totalSteps: counts.total,
          agentCallCount: counts.agents,
          staticParallelGroupCount: counts.parallelGroups,
          mapParallelGroupCount: counts.mapParallelGroups,
          whenStepCount: counts.whenSteps,
          loopStepCount: counts.loopSteps,
        },
      }
    },
  })
}
