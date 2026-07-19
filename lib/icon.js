const config = require("../config.json");

function isUrl(value) {
  return /^https?:\/\//.test(value);
}

const CUSTOM_EMOJI_PREFIX = "custom_emoji:";

/**
 * Resolve a Notion icon object for a provider.
 *
 * The provider_icons config value can be:
 *  - a plain emoji string (e.g. "😭")            → { type: "emoji", emoji: "..." }
 *  - a URL string (e.g. "https://...")           → { type: "external", external: { url: "..." } }
 *  - "custom_emoji:<uuid>"                        → { type: "custom_emoji", custom_emoji: { id: "..." } }
 *
 * @param {string} provider - e.g. "claude", "opencode", "grok"
 * @returns {{ type: "emoji", emoji: string } | { type: "external", external: { url: string } } | { type: "custom_emoji", custom_emoji: { id: string } } | null}
 */
function resolveProviderIcon(provider) {
  if (!provider) return null;
  const icons = config.provider_icons;
  if (!icons) return null;
  const value = icons[provider];
  if (!value) return null;

  if (typeof value === "string" && value.startsWith(CUSTOM_EMOJI_PREFIX)) {
    return {
      type: "custom_emoji",
      custom_emoji: { id: value.slice(CUSTOM_EMOJI_PREFIX.length) },
    };
  }

  if (isUrl(value)) {
    return { type: "external", external: { url: value } };
  }
  return { type: "emoji", emoji: value };
}

module.exports = { resolveProviderIcon };
