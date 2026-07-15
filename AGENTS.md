When the user asks you to plan or break down a task, output a JSON block wrapped in `<task-plan>` tags. Structure:

```json
{
  "project": "Project name",
  "goal": "One-line goal description",
  "tasks": [
    {
      "id": "t1",
      "title": "Task title",
      "description": "Detailed prompt for the agent",
      "provider": "claude",
      "model": "sonnet",
      "priority": "high",
      "subtasks": [
        {
          "id": "t1.1",
          "title": "Subtask title",
          "description": "...",
          "provider": "opencode",
          "model": "opencode-go/qwen3.7-plus",
          "priority": "medium"
        }
      ],
      "blocked_by": ["t2"],
      "related": ["t3"],
      "tags": ["Improvement"]
    }
  ]
}
```

**Provider options:** `claude`, `grok`, `opencode`

**Model options** (must match provider):

| Provider | Models |
|---|---|
| claude | `sonnet`, `opus`, `fable`, `haiku`, `best`, `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`, `claude-haiku-4-5` |
| grok | `grok-4.5`, `grok-composer-2.5-fast` |
| opencode | `opencode/big-pickle`, `opencode/deepseek-v4-flash-free`, `opencode/hy3-free`, `opencode/mimo-v2.5-free`, `opencode/nemotron-3-ultra-free`, `opencode/north-mini-code-free`, `opencode-go/deepseek-v4-flash`, `opencode-go/deepseek-v4-pro`, `opencode-go/glm-5.1`, `opencode-go/glm-5.2`, `opencode-go/kimi-k2.6`, `opencode-go/kimi-k2.7-code`, `opencode-go/mimo-v2.5`, `opencode-go/mimo-v2.5-pro`, `opencode-go/minimax-m2.7`, `opencode-go/minimax-m3`, `opencode-go/qwen3.6-plus`, `opencode-go/qwen3.7-max`, `opencode-go/qwen3.7-plus` |

If `model` is set but `provider` is omitted, provider is inferred from the model id (e.g. `opencode-go/*` → opencode).

**Priority options:** `urgent`, `high`, `medium`, `low`

After producing the plan, the user can pipe it to KADE:

```bash
node src/populate.js plan.json
# or
cat plan.json | ./scripts/populate-from-stdin.sh
```

Tasks appear in the Notion **Tasks** database under the linked **Projects** entry. Move a task to **In Progress** in Notion to trigger the poller daemon.
