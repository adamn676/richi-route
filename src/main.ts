import { createApp } from "vue";
import { createPinia } from "pinia";
import "@/styles/main.css";
import "maplibre-gl/dist/maplibre-gl.css";
import App from "@/App.vue";
import router from "@/router";
import PrimeVue from "primevue/config";
import Material from "@primeuix/themes/material";
import ToastService from "primevue/toastservice";

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.use(router);
app.use(ToastService);
app.use(PrimeVue, {
  ripple: true,
  theme: {
    preset: Material,
    options: {
      darkModeSelector: false || "none",
    },
  },
});
app.mount("#app");
