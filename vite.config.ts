import { defineConfig } from 'vite';

export default defineConfig({
  // Relative assets work at /terra-pavlodar/ and on a future custom domain.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
