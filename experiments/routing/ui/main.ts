import { createApp } from 'vue';
import App from './App.vue';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../../../src/config/map-worker';
import './style.css';

createApp(App).mount('#app');
