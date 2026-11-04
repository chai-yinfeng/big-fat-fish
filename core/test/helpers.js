export const T0 = Date.parse("2026-10-24T14:00:00.000Z");

export function fixedClock({ now = T0, parts = { hour: 10, minute: 0, weekday: 6, date: "2026-10-24" } } = {}) {
  let current = now;
  let currentParts = { ...parts };
  return {
    now: () => current,
    localParts: () => ({ ...currentParts }),
    setTime(value) {
      current = value;
    },
    setParts(value) {
      currentParts = { ...currentParts, ...value };
    },
  };
}

export function seqRng(values) {
  let index = 0;
  return {
    next() {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      return value;
    },
  };
}

export function alwaysRng(value) {
  return { next: () => value };
}
