// Budget value selection must preserve numeric zero. Using `||` silently turns
// a free-only budget into the default paid allowance.
export function firstSpecifiedBudget(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function validateBudgetAmount(value, { field = "max_price_usdc" } = {}) {
  if (value === undefined || value === null) {
    return { ok: true, present: false, amount: null, field };
  }
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) {
    return invalidBudget(field);
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return invalidBudget(field);
  return { ok: true, present: true, amount, field };
}

function invalidBudget(field) {
  return {
    ok: false,
    present: true,
    amount: null,
    field,
    code: "INVALID_BUDGET",
    message: `${field} must be a finite, non-negative number.`
  };
}
