/**
 * The changed middle of two child lists: `old[start..endOld)` is replaced by
 * `next[start..endNext)`; everything before `start` and from `endOld` /
 * `endNext` on is equal and stays in place.
 */
export function changedRun<T>(old: ArrayLike<T>, next: ArrayLike<T>, same: (a: T, b: T) => boolean): { start: number; endOld: number; endNext: number } {
  let start = 0;
  while (start < old.length && start < next.length && same(old[start]!, next[start]!)) start++;
  let endOld = old.length;
  let endNext = next.length;
  while (endOld > start && endNext > start && same(old[endOld - 1]!, next[endNext - 1]!)) {
    endOld--;
    endNext--;
  }
  return { start, endOld, endNext };
}

/**
 * Makes `parent`'s children equal to `next`'s by replacing only the changed
 * run (compared with `isEqualNode`). Typing in one paragraph swaps that one
 * block; the rest keeps its layout, and the pane keeps its scroll position.
 * `next` is consumed.
 */
export function patchChildren(parent: Node, next: DocumentFragment): void {
  const old = Array.from(parent.childNodes);
  const fresh = Array.from(next.childNodes);
  const { start, endOld, endNext } = changedRun(old, fresh, (a, b) => a.isEqualNode(b));
  for (let index = start; index < endOld; index++) old[index]!.remove();
  if (endNext === start) return;
  // Keep only the changed run in the fragment, then insert it in one step.
  for (let index = 0; index < start; index++) fresh[index]!.remove();
  for (let index = endNext; index < fresh.length; index++) fresh[index]!.remove();
  parent.insertBefore(next, old[endOld] ?? null);
}
