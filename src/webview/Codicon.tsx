/** @jsxImportSource preact */
import './codicons.css';

/** Decorative icons always accompany a text or accessible control label. */
export function Codicon({ name, class: className = '' }: { name: string; class?: string }) {
  return <span class={`codicon codicon-${name} ${className}`} aria-hidden="true" />;
}
