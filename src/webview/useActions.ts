import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createContext } from 'preact';
import type { ActionController } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';
export const ActionContext = createContext<ActionController | undefined>(undefined);

/** Subscribe to a slice, so progress elsewhere never rerenders whole lists. */
export function useActionSelector<T>(controller: ActionController, selector: (operations: readonly WorkspaceOperationState[]) => T): T {
  const select = useRef(selector); select.current = selector;
  const value = selector(controller.getSnapshot());
  const previous = useRef(value); previous.current = value;
  const [, changed] = useState(0);
  useLayoutEffect(() => {
    const update = () => {
      const next = select.current(controller.getSnapshot());
      if (!Object.is(previous.current, next)) { previous.current = next; changed(value => value + 1); }
    };
    const unsubscribe = controller.subscribe(update); update(); return unsubscribe;
  }, [controller]);
  return value;
}
