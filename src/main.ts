import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/main.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './config/map-worker';
import App from './App.vue';
createApp(App).use(createPinia()).mount('#app');
