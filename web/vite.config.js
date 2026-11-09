import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths so the same build works on GitHub Pages (/TvMap/) and inside the Android app
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  esbuild: { target: 'es2022' },
  optimizeDeps: { exclude: ['@huggingface/transformers'], esbuildOptions: { target: 'es2022' } },
});
