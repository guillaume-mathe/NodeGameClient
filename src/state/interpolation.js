/**
 * Linear interpolation between two entity objects over specified numeric fields.
 * Non-interpolated fields are taken from `next`.
 *
 * @param {object} prev  - Entity state at the earlier time
 * @param {object} next  - Entity state at the later time
 * @param {number} alpha - Interpolation factor (0 = prev, 1 = next)
 * @param {string[]} fields - Property names to interpolate
 * @returns {object} A new object with interpolated values
 */
export function lerpEntity(prev, next, alpha, fields) {
  const result = { ...next };
  for (const f of fields) {
    const a = prev[f];
    const b = next[f];
    if (typeof a === "number" && typeof b === "number") {
      result[f] = a + (b - a) * alpha;
    }
  }
  return result;
}
