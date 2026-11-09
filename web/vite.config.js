import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // relative paths so the same build works on GitHub Pages (/TvMap/) and inside the Android app
  base: './',
  // the Android app reads the data from the website (see .env.android), so it doesn't bundle it
  publicDir: mode === 'android' ? false : 'public',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  esbuild: { target: 'es2022' },
  optimizeDeps: { exclude: ['@huggingface/transformers'], esbuildOptions: { target: 'es2022' } },
}));
