const config = require("../config.json");

function isUrl(value) {
  return /^https?:\/\//.test(value);
}

/**
 * Resolve a Notion icon object for a provider.
 * @param {string} provider - e.g. "claude", "opencode", "grok"
 * @returns {{ type: "emoji", emoji: string } | { type: "external", external: { url: string } } | null}
 */
function resolveProviderIcon(provider) {
  if (!provider) return null;
  const icons = config.provider_icons;
  if (!icons) return null;
  const value = icons[provider];
  if (!value) return null;

  if (isUrl(value)) {
    return { type: "external", external: { url: value } };
  }
  return { type: "emoji", emoji: value };
}

module.exports = { resolveProviderIcon };
