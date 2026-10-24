/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GEOCODING_URL?: string;
}

declare module '@tabler/icons-vue/dist/esm/icons/*.mjs' {
  const icon: import('@tabler/icons-vue').Icon;
  export default icon;
}
