/** @jsxImportSource preact */
import { createElement, type ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** Load UI on first use; controllers and Host subscriptions remain in the shell. */
export function lazyFeature<P extends object>(label: string, loader: () => Promise<ComponentType<P>>): ComponentType<P> {
  let cached: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const load = () => pending ??= loader().then(component => { cached = component; return component; }).catch(error => {
    pending = undefined; throw error;
  });
  return function LazyFeature(props: P) {
    const active = (props as { active?: boolean }).active !== false;
    const [Component, setComponent] = useState<ComponentType<P> | undefined>(() => active ? cached : undefined);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (Component || !active) return;
      let cancelled = false;
      setFailed(false);
      void load().then(component => { if (!cancelled) setComponent(() => component); }, () => { if (!cancelled) setFailed(true); });
      return () => { cancelled = true; };
    }, [active, Component, attempt]);
    if (Component) return createElement(Component, props);
    if (!active) return null;
    return <section class="lazy-feature" aria-label={label} aria-busy={!failed}>
      <p role={failed ? 'alert' : 'status'}>{failed ? `${label}介面載入失敗，其他功能仍可使用。` : `正在載入${label}…`}</p>
      {failed && <button type="button" onClick={() => setAttempt(value => value + 1)}>重試載入{label}</button>}
    </section>;
  };
}
