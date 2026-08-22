## EVAL DEFINITION: AgentRouter routing contracts

### Capability evals

1. A returned `connect_agentrouter_account` action is converted directly into a browser approval URL by the MCP bridge.
2. Retrying the original request after approval stores the device credential and resumes the request without an install command.
3. Routing first emits a provider-neutral `data_requirement`, then selects an eligible source.
4. Paraphrases preserve capability, evidence type, and route.
5. Contrast pairs such as “research” versus “paper” and topic “track” versus parcel “track” remain distinct.

### Regression evals

1. Original 30-prompt corpus remains green.
2. Existing explicit `agentrouter_connect` flow remains supported.
3. Source-specific browser authorization remains distinct from AgentRouter account authorization.
4. Budget, payment, feedback, and BSC settlement tests remain green.

### Success metrics

- Capability evals: pass@1 = 100%.
- Release-critical regression evals: pass^3 = 100%.
- New state-machine and invariant test files: at least 80% line, branch, and function coverage.
