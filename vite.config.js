import { defineConfig } from 'vite';
export default defineConfig({
  root: 'public',
  server: { allowedHosts: ['terminal.local'] },
});
