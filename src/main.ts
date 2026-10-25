import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/main.css';
import 'vuetify/styles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './config/map-worker';
import App from './App.vue';
import { vuetify } from './plugins/vuetify';
createApp(App).use(createPinia()).use(vuetify).mount('#app');
