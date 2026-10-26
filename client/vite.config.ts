import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Read HOST/PORT from the project-root .env so the proxy follows the server.
  const env = loadEnv(mode, '..', '');
  const target = `http://${env.HOST || '127.0.0.1'}:${env.PORT || '8080'}`;
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, proxy: { '/api': target } },
  };
});
