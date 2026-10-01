import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/webview',
  base: './',
  build: {
    outDir: '../../resources/sidebar-webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/webview/sidebar.html',
      output: {
        entryFileNames: 'sidebar.js',
        assetFileNames: (asset) => asset.name?.endsWith('.css') ? 'sidebar.css' : '[name][extname]'
      }
    }
  }
});
