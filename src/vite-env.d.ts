/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEOCODING_URL?: string;
  readonly VITE_GOOGLE_MAPS_EMBED_KEY?: string;
}

declare module '@tabler/icons-vue/dist/esm/icons/*.mjs' {
  const icon: import('@tabler/icons-vue').Icon;
  export default icon;
}
