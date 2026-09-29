import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../resources/issue-webview',
    emptyOutDir: false,
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
