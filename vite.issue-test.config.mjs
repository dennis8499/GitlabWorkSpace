import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../resources/issue-webview',
    emptyOutDir: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/webview/issue-test.html',
      output: {
        entryFileNames: 'issue-test.js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'issue-test.css' : '[name][extname]'
      }
    }
  }
});
