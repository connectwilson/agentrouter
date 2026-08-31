export function validateJsonSchema(value, schema, path = "$") {
  const errors = [];

  if (!schema || typeof schema !== "object") {
    return errors;
  }

  for (const child of schema.allOf || []) errors.push(...validateJsonSchema(value, child, path));
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) {
    const matches = schema.anyOf.some((child) => validateJsonSchema(value, child, path).length === 0);
    if (!matches) errors.push(`${path} must match at least one anyOf schema`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) {
    const matches = schema.oneOf.filter((child) => validateJsonSchema(value, child, path).length === 0).length;
    if (matches !== 1) errors.push(`${path} must match exactly one oneOf schema`);
  }
  if (Object.hasOwn(schema, "const") && !jsonEqual(value, schema.const)) {
    errors.push(`${path} must equal the declared const value`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    errors.push(`${path} must be one of the declared enum values`);
  }

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = jsonType(value);
    const matchesType = expectedTypes.some((expected) => expected === actualType
      || (expected === "number" && actualType === "integer"));
    if (!matchesType) {
      errors.push(`${path} expected ${expectedTypes.join(" or ")}, got ${actualType}`);
      return errors;
    }
  }

  const actualType = jsonType(value);
  if ((schema.type === "object" || (!schema.type && schema.properties)) && actualType === "object") {
    const required = schema.required || [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${path}.${key} is required`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateJsonSchema(value[key], childSchema, `${path}.${key}`));
      }
    }
    const known = new Set(Object.keys(properties));
    for (const key of Object.keys(value)) {
      if (known.has(key)) continue;
      if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is an additional property and is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateJsonSchema(value[key], schema.additionalProperties, `${path}.${key}`));
      }
    }
    if (Number.isInteger(schema.minProperties) && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path} must contain at least ${schema.minProperties} properties`);
    }
    if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) {
      errors.push(`${path} must contain at most ${schema.maxProperties} properties`);
    }
  }

  if (actualType === "array") {
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`));
      });
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path} exceeds maxItems ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      const keys = value.map(stableJson);
      if (new Set(keys).size !== keys.length) errors.push(`${path} must contain unique items`);
    }
  }

  if (actualType === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path} is shorter than minLength ${schema.minLength}`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path} exceeds maxLength ${schema.maxLength}`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match pattern ${schema.pattern}`);
      } catch {
        errors.push(`${path} uses an invalid schema pattern`);
      }
    }
  }

  if (actualType === "number" || actualType === "integer") {
    if (!Number.isFinite(value)) {
      errors.push(`${path} must be a finite number`);
      return errors;
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} is below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} exceeds maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path} must be greater than ${schema.exclusiveMinimum}`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${path} must be less than ${schema.exclusiveMaximum}`);
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && !nearlyInteger(value / schema.multipleOf)) {
      errors.push(`${path} must be a multiple of ${schema.multipleOf}`);
    }
  }

  return errors;
}

function jsonType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function jsonEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function nearlyInteger(value) {
  return Math.abs(value - Math.round(value)) < 1e-10;
}

export function validateEnvelope(envelope) {
  const errors = validateJsonSchema(envelope, agentDataEnvelopeSchema);
  if (envelope?.status === "success" && !envelope.data) {
    errors.push("$.data is required for success responses");
  }
  if (envelope?.status === "error" && !envelope.error) {
    errors.push("$.error is required for error responses");
  }
  return errors;
}

export const agentDataEnvelopeSchema = {
  type: "object",
  required: ["schema_version", "service_id", "request_id", "status"],
  properties: {
    schema_version: { type: "string" },
    service_id: { type: "string" },
    request_id: { type: "string" },
    status: { type: "string" },
    query: { type: "object" },
    data: { type: "object" },
    metadata: {
      type: "object",
      required: ["data_sources", "generated_at", "freshness_seconds", "is_estimated", "confidence", "limitations"],
      properties: {
        data_sources: { type: "array", items: { type: "string" } },
        generated_at: { type: "string" },
        freshness_seconds: { type: "number" },
        is_estimated: { type: "boolean" },
        confidence: { type: "number" },
        limitations: { type: "array", items: { type: "string" } }
      }
    },
    agent_hints: { type: "object" },
    summary: { type: "string" },
    error: { type: "object" }
  }
};
