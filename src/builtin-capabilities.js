export const BUILTIN_CAPABILITY_CATEGORY = "Social research";

const BUILTIN_CAPABILITIES = Object.freeze([
  Object.freeze({
    capability: "social_user_voice_research",
    title: "Social user voice research",
    description: "Research real public discussion with source links, de-duplication, relevance filtering, and platform coverage diagnostics.",
    category: BUILTIN_CAPABILITY_CATEGORY,
    platforms: ["X", "Reddit", "小红书", "B站", "YouTube", "Facebook"],
    execution_location: "user_device",
    connector_status: "local_connector_required",
    credential_policy: "never_upload",
    access: "read_only"
  }),
  Object.freeze({
    capability: "social_post_read",
    title: "Read an X post",
    description: "Read one public X post by URL through the installed read-only browser connector, while the browser session stays on the user's device.",
    category: BUILTIN_CAPABILITY_CATEGORY,
    platforms: ["X"],
    execution_location: "user_device",
    connector_status: "local_connector_required",
    credential_policy: "never_upload",
    access: "read_only"
  })
]);

export function getBuiltinCapabilities() {
  return BUILTIN_CAPABILITIES.map((capability) => ({
    ...capability,
    platforms: [...capability.platforms]
  }));
}
