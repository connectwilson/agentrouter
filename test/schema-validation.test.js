import assert from "node:assert/strict";
import test from "node:test";

import { validateJsonSchema } from "../src/schema.js";

const schema = {
  type: "object",
  required: ["filters", "rows", "score"],
  additionalProperties: false,
  properties: {
    filters: {
      type: "object",
      required: ["asset"],
      additionalProperties: false,
      properties: {
        asset: { type: "string", pattern: "^[A-Z]{2,10}$", minLength: 2 }
      }
    },
    rows: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "integer", minimum: 1, maximum: 10 } }
      }
    },
    score: { type: "number", minimum: 0, maximum: 1 }
  }
};

test("JSON schema validation enforces nested constraints before a paid invocation", () => {
  assert.deepEqual(validateJsonSchema({
    filters: { asset: "ETH" },
    rows: [{ value: 3 }],
    score: 0.8
  }, schema), []);

  const errors = validateJsonSchema({
    filters: { asset: "eth", extra: true },
    rows: [{ value: 0.5 }, { value: 11 }, { value: 2 }],
    score: Infinity,
    unknown: true
  }, schema);
  for (const expected of ["pattern", "additional property", "integer", "maximum", "maxItems", "finite number"]) {
    assert.ok(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});

test("JSON schema validation supports composition and enum/const constraints", () => {
  const composed = {
    allOf: [{ type: "string", minLength: 3 }],
    oneOf: [{ const: "BTC" }, { const: "ETH" }],
    enum: ["BTC", "ETH"]
  };
  assert.deepEqual(validateJsonSchema("BTC", composed), []);
  assert.ok(validateJsonSchema("DOGE", composed).length >= 2);
});
