import type { Hooks, Plugin, PluginModule, PluginInput } from "@opencode-ai/plugin"
import path from "path"
import { fileURLToPath } from "url"
import { createWorkflowTool } from "./workflow-parse-tool"
import { WORKFLOW_AGENT_PROMPT } from "./workflow-agent-prompt"

/**
 * Resolve the plugin's own directory from the input.
 * input.directory is the project directory; we derive the plugin dir from __dirname (Bun).
 */
function getPluginDir(): string {
  // Bun sets import.meta.dirname for TS files
  try {
    // @ts-ignore
    return import.meta.dirname as string
  } catch {
    return path.dirname(fileURLToPath(import.meta.url))
  }
}

/**
 * OpenCode Workflow Plugin
 *
 * Registers:
 * 1. `workflow` agent — via Hooks.config, mutates config.agent to inject the workflow subagent
 * 2. `workflow-parse` tool — via Hooks.tool, parses workflow JS scripts into structured execution plans
 * 3. `workflow` skill — via Hooks.config, injects plugin's skill/ dir into config.skills.paths
 */
const serverPlugin: Plugin = async (input: PluginInput, _options): Promise<Hooks> => {
  // Build the workflow tool
  const workflowTool = createWorkflowTool()

  // Resolve plugin directory for skill path injection
  const pluginDir = getPluginDir()
  const skillDir = path.resolve(pluginDir, "..", "skill")

  // The config hook injects the workflow agent + skill path into OpenCode's config
  const configHandler = async (config: Record<string, unknown>) => {
    // Inject the workflow agent
    const agentConfig = config.agent as Record<string, Record<string, unknown>> | undefined
    if (!agentConfig) return

    agentConfig["workflow"] = {
      description:
        "Workflow 编排器：通过脚本编排 sub-agent 完成复杂任务。核心能力是并行调度——多个独立 agent 在同一 response 中并发执行（parallel/mapParallel），实现数倍加速。支持串行、when 条件判断、loop 循环迭代。",
      mode: "subagent",
      steps: 80,
      permission: {
        task: "allow",
        "workflow-parse": "allow",
      },
      prompt: WORKFLOW_AGENT_PROMPT,
    }

    // Restrict workflow-parse tool to the workflow agent only.
    // Add a global deny rule to config.permission (the "user" ruleset) so that
    // ALL agents — built-in, custom, and those registered by future plugins —
    // have workflow-parse hidden from their tool list. The workflow agent's own
    // permission config includes "workflow-parse": "allow", which is merged
    // AFTER the user ruleset and therefore takes precedence for that agent.
    const permConfig = config.permission as Record<string, unknown> | undefined
    if (!permConfig || typeof permConfig !== "object") {
      config.permission = { "workflow-parse": "deny" }
    } else if (!("workflow-parse" in permConfig)) {
      permConfig["workflow-parse"] = "deny"
    }

    // Inject the skill directory into config.skills.paths
    const skills = config.skills as { paths?: string[] } | undefined
    if (skills) {
      if (!skills.paths) skills.paths = []
      if (!skills.paths.includes(skillDir)) {
        skills.paths.push(skillDir)
      }
    } else {
      config.skills = { paths: [skillDir] }
    }
  }

  return {
    config: configHandler,
    tool: {
      "workflow-parse": workflowTool,
    },
  }
}

const pluginModule: PluginModule = {
  id: "opencode-workflow-plugin",
  server: serverPlugin,
}

export default pluginModule
