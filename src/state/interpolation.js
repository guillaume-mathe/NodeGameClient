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

/**
 * Interpolate specified component fields between two ECS entities.
 * Components not listed in `componentFields` snap to `next`.
 *
 * @param {{ id: number, components: object }} prev  - ECS entity at earlier time
 * @param {{ id: number, components: object }} next  - ECS entity at later time
 * @param {number} alpha - Interpolation factor (0 = prev, 1 = next)
 * @param {Object<string, string[]>} componentFields - e.g. `{ Position: ["x", "y"] }`
 * @returns {{ id: number, components: object }} A new entity with interpolated values
 */
export function lerpComponents(prev, next, alpha, componentFields) {
  const components = {};
  for (const name of Object.keys(next.components)) {
    const fields = componentFields[name];
    const prevComp = prev.components[name];
    if (fields && prevComp) {
      const nextComp = next.components[name];
      const lerped = { ...nextComp };
      for (const f of fields) {
        const a = prevComp[f];
        const b = nextComp[f];
        if (typeof a === "number" && typeof b === "number") {
          lerped[f] = a + (b - a) * alpha;
        }
      }
      components[name] = lerped;
    } else {
      components[name] = next.components[name];
    }
  }
  return { id: next.id, components };
}
