import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// the pages, built into ../docs which GitHub Pages serves on glc-hub.1lop.ru
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../docs',
    emptyOutDir: true,
    rollupOptions: { input: { index: 'index.html', embed: 'embed.html', admin: 'admin.html', rules: 'rules.html', login: 'login.html' } },
  },
});
