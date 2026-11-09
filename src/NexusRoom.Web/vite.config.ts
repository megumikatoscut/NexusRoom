import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';

export default defineConfig({
  plugins: [react()],
  define: { __NEXUSROOM_VERSION__: JSON.stringify(packageJson.version) },
  build: { outDir: '../NexusRoom.Host/wwwroot', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:17890' } },
});
