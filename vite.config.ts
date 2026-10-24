import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  envDir: false,
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    watch: { ignored: ['**/.cache/**', '**/experiments/routing/.local/**'] },
    proxy: {
      '/routing': { target: 'http://127.0.0.1:17777', rewrite: path => path.replace(/^\/routing/, '') },
      '/geocoding': { target: 'http://127.0.0.1:2322', rewrite: path => path.replace(/^\/geocoding/, '') },
      '/maps': { target: `http://127.0.0.1:${process.env.MAPS_PORT ?? 8088}`, rewrite: path => path.replace(/^\/maps/, '') },
      '/tiles': { target: 'http://127.0.0.1:8989', rewrite: path => path.replace(/^\/tiles/, '/mvt') },
    },
  },
});
