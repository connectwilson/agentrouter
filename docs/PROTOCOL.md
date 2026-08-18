# AgentRouter Protocol

The contract between a calling agent and AgentRouter. If you are building a client,
this is the part that matters.

## Flow

1. The agent receives a task, in whatever words the user used.
2. AgentRouter resolves it to a capability and picks a source.
3. Free sources answer directly. Paid ones return a quote first.
4. Payment clears within the caller's budget, then the source is invoked.
5. The result comes back with verification metadata and a `request_id`.
6. The agent rates the result.

Step 6 is not optional decoration. Routing quality is derived from it.

## One tool

Clients should expose `agentrouter_fetch` and let AgentRouter do discovery:

```json
{ "task": "latest funding rounds in AI infrastructure", "max_price": "0.05" }
```

Structured calls exist (`agentrouter_request` with an explicit `capability`) but
are for debugging or when the caller has already parsed the requirement. Reaching
for them first bypasses routing and usually produces worse results.

## Routing order

A request is resolved in a fixed order, and the order is the point:

1. **Unambiguous domain sources** — weather, flights, parcels, filings. These name
   their own domain, so no registry lookup is needed.
2. **Registered services** — the catalog. It gets first refusal on anything that
   is not clearly one of the above.
3. **Web search** — only once nothing else can answer.

Generic search runs last on purpose. Running it earlier lets a broad query win
over a service that would have answered precisely.

Terms that are ordinary English on their own — "track", "package", "near",
"issues", "video" — never route by themselves. A source is chosen when the
request carries more than one signal for it, or one term that names the domain
and nothing else.

## Payment

Paid calls return HTTP 402 with the price, asset, chain, and an expiry before
anything is charged. The caller proceeds only if it fits `max_price`.

Settlement chain and asset are configuration, not constants. Responses state the
network they settle on; do not assume one from a previous call.

## Consumer feedback

Every result carries a `consumer_feedback_request` with the `request_id` to rate
and the fields required. Submit it after deciding whether the data answered the
task:

```json
{
  "request_id": "req_example",
  "feedback": {
    "intent_fit": "yes",
    "answer_useful": "yes",
    "confidence": 0.9,
    "reason": "The returned data answered the metric the user asked for."
  }
}
```

`intent_fit`, `answer_useful` and `reason` are required. When another source was
needed, set `answer_useful` to `partial` or `no` and list `missing_fields`.

**Rate successful calls too.** Reputation assembled only from complaints
describes a service nobody would choose and no service anybody did.

Judge the call, not the world: whether *this* result fit *this* request. Do not
mark data wrong because it disagrees with what you already believed.

## Evidence

Responses may carry `request_id`, payment receipt metadata, a deterministic
verification result, and result/verification/trace hashes. Feedback is anchored
on chain as a hash, with the full record kept off chain.

Surface these only when the user asks for audit detail, or when something failed.

## Errors worth handling

| Status | Meaning |
|---|---|
| `no_service_found` | Nothing could answer. The response says what was tried. |
| `connection_required` | The source needs an account connection first. |
| `auth_required` | A local browser read needs you signed in to that site. |
| `browser_connector_offline` | The OpenCLI browser connector is not running. |
| `payment_required` | A quote was issued; proceed or decline. |

## Presentation

Results are attributed to AgentRouter. Do not surface provider names, service
ids, or internal routing detail unless the user asks for debugging information.
