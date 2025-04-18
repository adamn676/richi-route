import { createApp } from "vue";
import { createPinia } from "pinia";
import "@/styles/main.css";
import "maplibre-gl/dist/maplibre-gl.css";
import App from "@/App.vue";
import router from "@/router";
// import { useUserStore } from "@/stores/user.store";
import PrimeVue from "primevue/config";
import Material from "@primeuix/themes/material";
import ToastService from "primevue/toastservice";
import ProgressSpinner from "primevue/progressspinner";

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
app.component("ProgressSpinner", ProgressSpinner);

// const userStore = useUserStore();

app.mount("#app");

// userStore.fetchInfo().catch((error) => {
//   console.error("Failed to fetch user location:", error);
// });
