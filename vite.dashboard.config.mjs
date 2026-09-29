import { defineConfig } from 'vite';
import postcss from 'postcss';

const scopeIssueStyles = {
  name: 'scope-issue-view-styles',
  enforce: 'pre',
  transform(code, id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/webview/style.css')) return null;
    const root = postcss.parse(code, { from: id });
    root.walkRules((rule) => {
      let keyframe = false;
      for (let parent = rule.parent; parent; parent = parent.parent) {
        if (parent.type === 'atrule' && /keyframes/i.test(parent.name)) { keyframe = true; break; }
      }
      if (keyframe) return;
      rule.selectors = rule.selectors.map((selector) => {
        const value = selector.trim();
        if (value === ':root' || value === 'body' || value === 'html') return '#issue-panel';
        if (value === '*') return '#issue-panel, #issue-panel *';
        if (value.startsWith('.vscode-high-contrast ')) return `body.vscode-high-contrast #issue-panel ${value.slice('.vscode-high-contrast '.length)}`;
        return `#issue-panel ${value}`;
      });
    });
    return { code: root.toString(), map: null };
  }
};

export default defineConfig({
  plugins: [scopeIssueStyles],
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../resources/issue-webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/webview/dashboard.html',
      output: {
        entryFileNames: 'dashboard.js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'dashboard.css' : '[name][extname]'
      }
    }
  }
});
