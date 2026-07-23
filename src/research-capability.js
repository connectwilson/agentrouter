import { searchPublicDiscussions } from "./research-search.js";
import { buildCreatorResearchReport } from "./research-synthesis.js";

export async function runSocialResearchCapability(params = {}, options = {}) {
  const question = String(params.question || "").trim();
  if (!question) {
    return {
      ok: false,
      status: "invalid_request",
      error: { code: "RESEARCH_QUESTION_REQUIRED", message: "params.question is required" }
    };
  }

  const search = await (options.search || searchPublicDiscussions)(params, options.searchOptions || {});
  const report = (options.synthesize || buildCreatorResearchReport)({
    question,
    candidates: search.candidates,
    evidence: params.evidence || []
  });
  const completedPlatforms = search.searches
    .filter((item) => /^completed/.test(item.status))
    .map((item) => item.platform);

  return {
    ok: report.answer_status === "evidence_based",
    status: report.answer_status === "evidence_based" ? "completed" : search.status,
    protocol: {
      protocol_version: "agent_router_social_research_v1",
      route_type: "local_first_social_capability",
      execution_location: "user_device_for_local_sources",
      credential_policy: "never_upload",
      raw_result_policy: "local_only_by_default",
      write_access: false
    },
    request: { capability: "social_user_voice_research", params: { ...params, question } },
    result: { report, search },
    verification: {
      source_links_present: report.evidence.every((item) => /^https?:\/\//.test(item.canonical_url || "")),
      direct_voice_items: report.quality.direct_voice_items,
      verified_voice_platforms: report.quality.verified_voice_platforms,
      completed_platforms: [...new Set(completedPlatforms)]
    },
    action_required: search.action_required || []
  };
}
