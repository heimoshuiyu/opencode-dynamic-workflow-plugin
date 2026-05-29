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
        "Workflow 编排器：执行 workflow 脚本，调度 sub-agent 完成复杂任务。支持串行、并行、动态 mapParallel。",
      mode: "subagent",
      steps: 80,
      permission: {
        task: "allow",
      },
      prompt: WORKFLOW_AGENT_PROMPT,
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
