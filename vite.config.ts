import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    {
      name: 'startup-timing',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = request.url?.split('?')[0];
          if (path === '/' || path === '/index.html') {
            const start = performance.now();
            console.info(
              `[startup:vite] HTML requested at ${new Date().toISOString()}`,
            );
            response.once('finish', () => {
              console.info(
                `[startup:vite] HTML sent in ${Math.round(performance.now() - start)} ms at ${new Date().toISOString()}`,
              );
            });
          }
          next();
        });
      },
    },
    react(),
  ],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 1420,
    // Tauri watches Rust itself. Scanning its build tree with Chokidar blocks
    // cold HTML requests on Windows; local tooling trees are not frontend input.
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/.opencode/**',
        '**/.agents/**',
        '**/.workbuddy-ai/**',
      ],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
});
