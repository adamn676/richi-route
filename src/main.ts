import { createApp } from "vue";
import { createPinia } from "pinia";
import "@/styles/main.css";
import "maplibre-gl/dist/maplibre-gl.css";
import App from "@/App.vue";
import PrimeVue from "primevue/config";
import Material from "@primeuix/themes/material";

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.use(PrimeVue, {
  ripple: true,
  theme: {
    preset: Material,
  },
});
app.mount("#app");
