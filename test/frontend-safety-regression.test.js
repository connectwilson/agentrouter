import assert from "node:assert/strict";
import test from "node:test";

import { clientRouterScript } from "../src/app-shell.js";
import { accountHtml, agentHtml } from "../src/home.js";
import { studioHtml } from "../src/studio.js";

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("client-side navigation never evaluates fetched page scripts under CSP", () => {
  const script = clientRouterScript();

  assert.doesNotMatch(script, /\bnew\s+Function\s*\(|\beval\s*\(/);
});

test("deposit confirmation polling reads nested error.code before deciding whether to retry", () => {
  const polling = section(
    accountHtml(),
    "async function claimWhenConfirmed",
    "function refreshDepositQr"
  );

  assert.match(polling, /payload\.error\?\.code/);
  assert.match(polling, /DEPOSIT_NOT_CONFIRMED[\s\S]*DEPOSIT_NOT_FOUND[\s\S]*setTimeout/);
});

test("Studio batch publish gates success UI on a successful HTTP response", () => {
  const publishHandler = section(
    studioHtml(),
    'publishDrafts.addEventListener("click"',
    "function renderDraftList"
  );
  const responseGuard = publishHandler.search(/if\s*\([^)]*!response\.ok[^)]*\)/);
  const successCopy = publishHandler.indexOf("Verified and published to");

  assert.notEqual(responseGuard, -1, "non-2xx publish responses must enter the visible error path");
  assert.ok(responseGuard < successCopy, "the HTTP failure guard must run before rendering success");
  assert.match(publishHandler, /status\.textContent\s*=\s*"Publish error"/);
});

test("unauthenticated Marketplace hire exposes a visible authentication action", () => {
  const hireHandler = section(
    agentHtml(),
    "async function hireErc8004Agent",
    "function renderPager"
  );

  assert.match(hireHandler, /importedResponse\.status\s*===\s*401|AUTH_REQUIRED|auth_required/i);
  assert.match(hireHandler, /data-auth-modal-trigger|[?&]login=1|(?:open|show)AuthModal/i);
  assert.match(
    hireHandler,
    /(?:button|result)\.(?:textContent|innerHTML)\s*=[\s\S]{0,160}(?:Sign in|Log in|Connect account)/i
  );
});
