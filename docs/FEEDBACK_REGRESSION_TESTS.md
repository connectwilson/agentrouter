# AgentRouter feedback regression corpus

The canonical user-feedback corpus is `test/fixtures/agentrouter-feedback-regressions.json`.

Every confirmed AgentRouter failure reported by a user must be handled in this order:

1. Add a stable `AR-BUG-NNN` entry describing the observed failure and expected behavior.
2. Reference at least one executable `node:test` file from that entry.
3. Run the new test and capture the intended RED result before changing production behavior.
4. Apply the smallest fix and rerun the same test to GREEN.
5. Run `node --test test/agentrouter-feedback-corpus.test.js` so missing files, duplicate IDs, and corpus drift fail CI.
6. Keep the original user wording in `routing_cases` when the failure is a routing or intent-classification problem.

The first 30 routing cases are the original user-authored acceptance corpus. They must remain data-driven and must not be replaced with easier paraphrases. New cases are appended; old cases are only changed when the expected product contract intentionally changes.
