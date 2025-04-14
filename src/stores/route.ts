import { defineStore } from "pinia";
import { ref } from "vue";

export const useRouteStore = defineStore("route", () => {
  const points = ref<{ lat: number; lng: number }[]>([]);
  const route = ref<any>(null); // Holds route data from OpenRouteService

  function addPoint(lat: number, lng: number) {
    points.value.push({ lat, lng });
  }

  function removePoint(index: number) {
    points.value.splice(index, 1);
  }

  function setRoute(newRoute: any) {
    route.value = newRoute;
  }

  return { points, route, addPoint, removePoint, setRoute };
});
