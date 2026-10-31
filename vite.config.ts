import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import vuetify from 'vite-plugin-vuetify';
import { fileURLToPath, URL } from 'node:url';
import { surfaceCorrections } from './scripts/surface-corrections.ts';
import { offlinePackages } from './scripts/offline-packages.ts';

const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  envDir: false,
  // Vuetify components and their styles are imported where used.
  plugins: [vue(), vuetify({ autoImport: true }),
    surfaceCorrections(file('./config/surface-corrections.json'), file('./experiments/routing/.local/local-routing-rules/surfaces.tsv')),
    offlinePackages(file('./.cache/offline/packages'))],
  resolve: { alias: { '@': file('./src') } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    watch: { ignored: ['**/.cache/**', '**/experiments/routing/.local/**'] },
    proxy: {
      '/routing': { target: 'http://127.0.0.1:17777', rewrite: path => path.replace(/^\/routing/, '') },
      '/geocoding': { target: `http://127.0.0.1:${process.env.SEARCH_PORT ?? 2322}`, rewrite: path => path.replace(/^\/geocoding/, '') },
      '/maps': { target: `http://127.0.0.1:${process.env.MAPS_PORT ?? 8088}`, rewrite: path => path.replace(/^\/maps/, '') },
      '/tiles': { target: 'http://127.0.0.1:8989', rewrite: path => path.replace(/^\/tiles/, '/mvt') },
    },
  },
});
