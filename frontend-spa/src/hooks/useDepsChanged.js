import { useState } from 'react';

// Returns true during the one render in which any of `deps` differs (by
// Object.is) from the previous render — false on mount. Lets a component
// reset derived state while rendering instead of in an effect, so the stale
// value never paints and no extra effect-driven render pass is needed:
//
//   if (useDepsChanged([rows.length, pageSize])) setPage(1);
//
// See https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
export default function useDepsChanged(deps) {
  const [prevDeps, setPrevDeps] = useState(deps);
  const changed = deps.length !== prevDeps.length || deps.some((dep, i) => !Object.is(dep, prevDeps[i]));
  if (changed) setPrevDeps(deps);
  return changed;
}
