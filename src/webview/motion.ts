import type { RefObject } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

type PresencePhase = 'entering' | 'entered' | 'exiting' | 'exited';

/** Missing media-query support uses the static path, including lightweight test DOMs. */
function reducedMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReduced(query.matches);
    query.addEventListener?.('change', changed);
    changed();
    return () => query.removeEventListener?.('change', changed);
  }, []);
  return reduced;
}

/** Retains only visual presence during exit; callers stop demand at open=false. */
export function usePresence(open: boolean, { durationMs = 200, immediate = false, resetKey, onExited }: {
  durationMs?: number; immediate?: boolean; resetKey?: string; onExited?: () => void;
} = {}) {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<PresencePhase>(open ? reduced || immediate ? 'entered' : 'entering' : 'exited');
  const phaseRef = useRef(phase);
  const generation = useRef(0);
  const previousReset = useRef(resetKey);
  const exited = useRef(onExited); exited.current = onExited;
  const finish = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const epoch = ++generation.current;
    const reset = previousReset.current !== resetKey;
    previousReset.current = resetKey;
    const change = (next: PresencePhase) => { phaseRef.current = next; setPhase(next); };
    const complete = () => {
      if (generation.current !== epoch) return;
      const leaving = !open && phaseRef.current !== 'exited';
      change(open ? 'entered' : 'exited');
      if (leaving) exited.current?.();
    };
    finish.current = complete;
    if (reset || reduced || immediate || !open && phaseRef.current === 'exited') { complete(); return; }
    change(open ? 'entering' : 'exiting');
    // The fallback also handles hidden documents and interrupted CSS animations.
    const timer = window.setTimeout(complete, durationMs + 50);
    return () => window.clearTimeout(timer);
  }, [open, reduced, immediate, resetKey, durationMs]);
  const onAnimationEnd = useCallback((event: AnimationEvent) => {
    if (event.target === event.currentTarget) finish.current();
  }, []);
  return { present: phase !== 'exited', phase, onAnimationEnd };
}

/** Animate stable DOM only when navigation changes, never on snapshot updates. */
export function useVisualTransition<T extends HTMLElement>(element: RefObject<T>, identity: string, active = true): void {
  const reduced = useReducedMotion();
  const previous = useRef(identity);
  useLayoutEffect(() => {
    const changed = previous.current !== identity;
    previous.current = identity;
    if (!changed || !active || reduced || document.hidden || !element.current?.animate) return;
    const animation = element.current.animate([{ opacity: .35, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 160, easing: 'cubic-bezier(.2,0,0,1)' });
    return () => animation.cancel();
  }, [identity, active, reduced]);
}
