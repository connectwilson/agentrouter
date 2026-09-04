# AgentRouter Advantage Report — BNB Golden Tasks

Status: **awaiting production evidence**. This report must be populated from recorded runs; placeholder cells must not be presented as measured results.

## Question

For a bounded BSC decision task, does AgentRouter reduce the time and setup required to find, select, call, and verify a specialist Agent compared with manual research or a direct provider integration?

## Tasks

Use three Golden Tasks with identical inputs across both paths:

1. Rebalancing — analyze one PancakeSwap concentrated-liquidity position and propose a replacement range.
2. Yield Optimisation — compare live BSC USDC opportunities and return a risk-adjusted choice.
3. Health Factor — inspect one Venus lending position and return liquidation risk and protective actions.

All runs are read-only or simulations. Inputs, observation time, risk policy, and expected output schema must be fixed before either path begins.

## Comparison protocol

**AgentRouter path:** start at `/bnb`, choose the task, compare Agents, Hire, and stop when the standardized result plus feedback status is visible.

**Baseline path:** start with a clean environment, identify a suitable provider, read its integration instructions, configure any required access, make the equivalent direct request, and manually assemble the same result fields and source evidence.

Run each path three times. Report the median and retain every raw output. Do not include one-time login time in repeat-run latency, but report setup time separately.

## Results

| Task | Path | Setup time | Completion time | Actual cost | Required fields present | Sources verifiable | Pre-install/config required | Output artifact |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| Rebalancing | AgentRouter | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Rebalancing | Manual/direct | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Yield Optimisation | AgentRouter | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Yield Optimisation | Manual/direct | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Health Factor | AgentRouter | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| Health Factor | Manual/direct | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

## Metric definitions

- **Setup time:** time spent installing, connecting, authenticating, or configuring a provider before the first runnable request.
- **Completion time:** task submission to a decision-ready result, excluding human reading after the result is complete.
- **Actual cost:** provider charge reported by the execution path; unknown costs remain unknown.
- **Required fields present:** percentage of the Golden Task's required output fields returned without manual reconstruction.
- **Sources verifiable:** every material claim has an accessible source or on-chain reference.
- **Pre-install/config required:** provider-specific work required before the task can run.

## Required attachments

For every measured row, retain the original input, timestamps, selected Agent/provider, request ID, raw structured output, source list, declared price, actual cost, evidence trace, feedback status, and public chain links when applicable.

The conclusion should be written only after these artifacts exist. The useful long-term claim is not “AgentRouter always wins”; it is the boundary under which dynamic discovery, standardized evidence, and post-call trust are measurably better than manual or direct integration.
