<template>
  <header
    class="app-header bg-white shadow-sm py-2 px-4 h-16 flex items-center justify-between"
  >
    <div class="flex items-center space-x-4">
      <!-- Logo -->
      <div class="flex items-center">
        <Icon name="pi-bicycle" class="text-blue-600 text-2xl mr-2" />
        <h1 class="text-xl font-semibold text-gray-800">RichiRoute</h1>
      </div>

      <!-- Navigation menu -->
      <nav class="hidden md:block">
        <ul class="flex space-x-6">
          <li>
            <router-link to="/" class="text-gray-600 hover:text-blue-600"
              >Home</router-link
            >
          </li>
          <li>
            <router-link to="/about" class="text-gray-600 hover:text-blue-600"
              >About</router-link
            >
          </li>
        </ul>
      </nav>
    </div>

    <div class="flex items-center space-x-4">
      <!-- User actions -->
      <Button
        type="button"
        label="Login"
        icon="pi pi-user"
        class="p-button-outlined p-button-sm"
      />

      <!-- Mobile menu toggle -->
      <Button
        type="button"
        class="p-button-text p-button-rounded p-button-sm md:hidden"
        icon="pi pi-bars"
        @click="toggleMobileMenu"
      />
    </div>

    <!-- Mobile menu overlay -->
    <div
      v-if="isMobileMenuOpen"
      class="fixed inset-0 bg-gray-800 bg-opacity-75 z-50 md:hidden"
      @click="closeMobileMenu"
    >
      <div class="bg-white w-64 h-full p-4" @click.stop>
        <div class="flex justify-between items-center mb-6">
          <h2 class="text-lg font-semibold">Menu</h2>
          <Button
            type="button"
            class="p-button-text p-button-rounded p-button-sm"
            icon="pi pi-times"
            @click="closeMobileMenu"
          />
        </div>

        <nav>
          <ul class="space-y-4">
            <li>
              <router-link
                to="/"
                class="block p-2 hover:bg-gray-100 rounded"
                @click="closeMobileMenu"
              >
                Home
              </router-link>
            </li>
            <li>
              <router-link
                to="/about"
                class="block p-2 hover:bg-gray-100 rounded"
                @click="closeMobileMenu"
              >
                About
              </router-link>
            </li>
          </ul>
        </nav>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import Icon from "../ui/Icon.vue";

const isMobileMenuOpen = ref(false);

const toggleMobileMenu = () => {
  isMobileMenuOpen.value = !isMobileMenuOpen.value;
};

const closeMobileMenu = () => {
  isMobileMenuOpen.value = false;
};
</script>
