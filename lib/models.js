/** Available models per provider — sourced from local CLI listings. */

const MODELS = {
  claude: [
    "sonnet",
    "opus",
    "fable",
    "haiku",
    "best",
    "claude-sonnet-5",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-haiku-4-5",
  ],
  grok: ["grok-4.5", "grok-composer-2.5-fast"],
  opencode: [
    "opencode/big-pickle",
    "opencode/deepseek-v4-flash-free",
    "opencode/hy3-free",
    "opencode/mimo-v2.5-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/north-mini-code-free",
    "opencode-go/deepseek-v4-flash",
    "opencode-go/deepseek-v4-pro",
    "opencode-go/glm-5.1",
    "opencode-go/glm-5.2",
    "opencode-go/kimi-k2.6",
    "opencode-go/kimi-k2.7-code",
    "opencode-go/mimo-v2.5",
    "opencode-go/mimo-v2.5-pro",
    "opencode-go/minimax-m2.7",
    "opencode-go/minimax-m3",
    "opencode-go/qwen3.6-plus",
    "opencode-go/qwen3.7-max",
    "opencode-go/qwen3.7-plus",
  ],
};

const DEFAULT_MODEL = {
  claude: "sonnet",
  grok: "grok-4.5",
  opencode: "opencode-go/qwen3.7-plus",
};

const ALL_MODELS = [
  ...MODELS.claude,
  ...MODELS.grok,
  ...MODELS.opencode,
];

function inferProvider(model) {
  if (!model) return null;
  if (model.startsWith("opencode-go/") || model.startsWith("opencode/")) {
    return "opencode";
  }
  if (model.startsWith("grok-")) return "grok";
  if (
    MODELS.claude.includes(model) ||
    model.startsWith("claude-")
  ) {
    return "claude";
  }
  return null;
}

function resolveModel(provider, model) {
  const p = provider || inferProvider(model) || "claude";
  if (model && isValidModel(p, model)) return model;
  return DEFAULT_MODEL[p] || null;
}

function isValidModel(provider, model) {
  return MODELS[provider]?.includes(model) ?? false;
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  ALL_MODELS,
  inferProvider,
  resolveModel,
  isValidModel,
};
