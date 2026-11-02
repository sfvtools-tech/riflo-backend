/** Process-local admission: reject immediately rather than queue unbounded work. */
export function createCapacity(totalLimit: number, accountLimit: number) {
  if (![totalLimit, accountLimit].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Capacity limits must be positive safe integers.');
  let total = 0;
  const accounts = new Map<string, number>();
  return (uid: string): (() => void) | 429 | 503 => {
    const active = accounts.get(uid) ?? 0;
    if (active >= accountLimit) return 429;
    if (total >= totalLimit) return 503;
    total++;
    accounts.set(uid, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      total--;
      const remaining = accounts.get(uid)! - 1;
      if (remaining) accounts.set(uid, remaining); else accounts.delete(uid);
    };
  };
}
