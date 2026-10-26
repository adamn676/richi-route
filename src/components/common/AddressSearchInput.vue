<template>
  <!-- A combobox keeps typed text and offers matching places; Vuetify handles the menu and its keys, Enter in the field is
       handled here. Empty text is no value, so the field shows its placeholder, which says what to do, and no clear
       button. -->
  <v-combobox
    :id="`address-${waypointId}`"
    :model-value="inputValue || null"
    :items="suggestions"
    item-title="label"
    return-object
    no-filter
    :label="label"
    :placeholder="placeholder"
    persistent-placeholder
    :disabled="disabled"
    :loading="isLoading"
    :hide-no-data="!errorMessage && !nothingFound"
    menu-icon=""
    v-model:menu="menu"
    clearable
    persistent-clear
    autocomplete="off"
    @update:model-value="onUpdate"
    v-model:focused="focused"
    @keydown.enter="submitText"
    @keydown.esc="cancelSearch"
  >
    <template #no-data>
      <v-list-item v-if="errorMessage" role="alert" base-color="error" :title="errorMessage" />
      <v-list-item v-else title="Keine Adresse gefunden. Du kannst den Punkt auch auf der Karte setzen." />
    </template>
  </v-combobox>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useDisplay } from 'vuetify';
import { forwardGeocode, type Place } from '@/services/geocoding.service';

const props = withDefaults(defineProps<{
  modelValue: string;
  waypointId: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}>(), {
  placeholder: 'Adresse suchen',
  disabled: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'item-select': [place: Place];
  'text-submit': [query: string];
}>();

const { mobile } = useDisplay();
const inputValue = ref(props.modelValue);
const suggestions = ref<Place[]>([]);
const isLoading = ref(false);
const errorMessage = ref<string | null>(null);
// The answer arrives after typing, so it opens the menu itself while the field has focus.
const menu = ref(false), focused = ref(false);
const nothingFound = ref(false);
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let currentRequest: AbortController | null = null;
let version = 0;

watch(() => props.modelValue, (value) => {
  if (value !== inputValue.value) {
    inputValue.value = value;
    cancelSearch();
    suggestions.value = [];
    menu.value = false;
  }
});

function cancelSearch(): void {
  version++;
  clearTimeout(debounceTimer);
  currentRequest?.abort();
  currentRequest = null;
  isLoading.value = false;
  nothingFound.value = false;
}

// Searches 350 ms after the last keystroke, from three characters; a newer search drops older answers.
function queueSearch(value: string): void {
  cancelSearch();
  suggestions.value = [];
  errorMessage.value = null;
  if (value.trim().length < 3) return;

  const requestVersion = version;
  debounceTimer = setTimeout(() => {
    const controller = new AbortController();
    currentRequest = controller;
    isLoading.value = true;
    void forwardGeocode(value, controller.signal)
      .then((places) => {
        if (version !== requestVersion) return;
        suggestions.value = places;
        nothingFound.value = !places.length;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || version !== requestVersion) return;
        console.error('Adressvorschläge konnten nicht geladen werden:', error);
        errorMessage.value = error instanceof Error ? error.message : 'Adresssuche fehlgeschlagen. Bitte erneut versuchen.';
      })
      .finally(() => {
        if (version !== requestVersion) return;
        isLoading.value = false;
        menu.value = focused.value;
      });
  }, 350);
}

// A chosen place closes the keyboard on phones, so the sheet gives the map back; only once Vuetify has closed its menu,
// which would take the focus back.
function closeKeyboard(): void {
  if (mobile.value) setTimeout(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Typing (or clearing) gives text; choosing a suggestion gives the place, then its label as text, which needs no search.
function onUpdate(value: Place | string | null): void {
  if (value && typeof value === 'object') {
    cancelSearch();
    inputValue.value = value.label;
    suggestions.value = [];
    menu.value = false;
    emit('update:modelValue', value.label);
    emit('item-select', value);
    closeKeyboard();
    return;
  }
  if ((value ?? '') === inputValue.value) return;
  inputValue.value = value ?? '';
  emit('update:modelValue', inputValue.value);
  queueSearch(inputValue.value);
}

// Enter takes the first suggestion, or else searches the typed text directly; one picked with the arrow keys is taken in
// the menu.
function submitText(): void {
  if (suggestions.value.length) { onUpdate(suggestions.value[0]); return; }
  if (inputValue.value.trim().length < 3) return;
  cancelSearch();
  menu.value = false;
  emit('text-submit', inputValue.value.trim());
  closeKeyboard();
}

onBeforeUnmount(cancelSearch);
</script>
