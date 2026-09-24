import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../resources/issue-webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/webview/index.html',
      output: {
        entryFileNames: 'issue.js',
        assetFileNames: 'issue.[ext]'
      }
    }
  }
});
