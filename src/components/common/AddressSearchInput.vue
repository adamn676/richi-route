<template>
  <div class="address-search float" :class="{ 'float--raised': raised }">
    <input
      :id="`address-${waypointId}`"
      ref="input"
      class="field"
      type="text"
      autocomplete="off"
      :value="inputValue"
      :placeholder="placeholder"
      :disabled="disabled"
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-controls="`suggestions-${waypointId}`"
      :aria-expanded="isOpen"
      :aria-activedescendant="activeIndex >= 0 ? `suggestion-${waypointId}-${activeIndex}` : undefined"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <button v-if="inputValue && !disabled" type="button" class="address-search__clear" aria-label="Eingabe löschen" title="Eingabe löschen"
      @mousedown.prevent @click="clear"><IconX :size="16" aria-hidden="true" /></button>
    <label :for="`address-${waypointId}`">{{ label }}</label>
    <span v-if="isLoading" class="address-search__loading" aria-live="polite">Suche …</span>
    <ul
      v-if="isOpen && suggestions.length"
      ref="popup"
      :id="`suggestions-${waypointId}`"
      role="listbox"
      class="address-search__results popover"
    >
      <li
        v-for="(place, index) in suggestions"
        :id="`suggestion-${waypointId}-${index}`"
        :key="`${place.coord.join(',')}-${index}`"
        role="option"
        :aria-selected="activeIndex === index"
        :class="{ 'is-active': activeIndex === index }"
        @mousedown.prevent
        @click="selectPlace(place)"
        @mouseenter="activeIndex = index"
      >
        {{ place.label }}
      </li>
    </ul>
    <div v-if="isOpen && errorMessage" ref="popup" class="address-search__feedback popover" role="alert">{{ errorMessage }}</div>
    <div
      v-else-if="isOpen && !isLoading && inputValue.trim().length >= 3 && !suggestions.length && !isWaiting"
      ref="popup"
      class="address-search__feedback popover"
      aria-live="polite"
    >
      Keine Adresse gefunden. Du kannst den Punkt auch auf der Karte setzen.
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { forwardGeocode, type Place } from '@/services/geocoding.service';
import { IconX } from '@/components/icons';

const props = withDefaults(defineProps<{
  modelValue: string;
  waypointId: string;
  label: string;
  placeholder?: string;
  // Keeps the label up when the placeholder stands for a value, such as a point's position.
  raised?: boolean;
  disabled?: boolean;
}>(), {
  placeholder: 'Adresse suchen',
  raised: false,
  disabled: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'item-select': [place: Place];
  'text-submit': [query: string];
}>();

const inputValue = ref(props.modelValue);
const suggestions = ref<Place[]>([]);
const isOpen = ref(false);
const isLoading = ref(false);
const isWaiting = ref(false);
const activeIndex = ref(-1);
const errorMessage = ref<string | null>(null);
const popup = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let blurTimer: ReturnType<typeof setTimeout> | undefined;
let currentRequest: AbortController | null = null;
let version = 0;

watch(() => props.modelValue, (value) => {
  if (value !== inputValue.value) {
    inputValue.value = value;
    cancelSearch();
    suggestions.value = [];
    isOpen.value = false;
  }
});

watch([suggestions, isLoading, errorMessage, isOpen, activeIndex], () => {
  const target = activeIndex.value >= 0 && suggestions.value.length
    ? popup.value?.children[activeIndex.value] : popup.value;
  target?.scrollIntoView({ block: 'nearest' });
}, { flush: 'post' });

function cancelSearch(): void {
  version++;
  clearTimeout(debounceTimer);
  currentRequest?.abort();
  currentRequest = null;
  isLoading.value = false;
  isWaiting.value = false;
}

function queueSearch(value: string): void {
  cancelSearch();
  suggestions.value = [];
  activeIndex.value = -1;
  errorMessage.value = null;
  isOpen.value = true;
  if (value.trim().length < 3) return;

  const requestVersion = version;
  isWaiting.value = true;
  debounceTimer = setTimeout(() => {
    const controller = new AbortController();
    currentRequest = controller;
    isWaiting.value = false;
    isLoading.value = true;
    void forwardGeocode(value, controller.signal)
      .then((places) => {
        if (version !== requestVersion) return;
        suggestions.value = places;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || version !== requestVersion) return;
        console.error('Adressvorschläge konnten nicht geladen werden:', error);
        errorMessage.value = error instanceof Error ? error.message : 'Adresssuche fehlgeschlagen. Bitte erneut versuchen.';
      })
      .finally(() => {
        if (version === requestVersion) isLoading.value = false;
      });
  }, 350);
}

function onInput(event: Event): void {
  inputValue.value = (event.target as HTMLInputElement).value;
  emit('update:modelValue', inputValue.value);
  queueSearch(inputValue.value);
}

// Empties the field and keeps the cursor there for the next address; the stop stays until one is chosen.
function clear(): void {
  cancelSearch();
  inputValue.value = '';
  suggestions.value = [];
  errorMessage.value = null;
  isOpen.value = false;
  emit('update:modelValue', '');
  input.value?.focus();
}

function onFocus(): void {
  clearTimeout(blurTimer);
  if (suggestions.value.length) {
    isOpen.value = true;
  } else if (inputValue.value.trim().length >= 3) {
    queueSearch(inputValue.value);
  }
}

function onBlur(): void {
  blurTimer = setTimeout(() => { isOpen.value = false; }, 150);
}

function selectPlace(place: Place): void {
  cancelSearch();
  inputValue.value = place.label;
  suggestions.value = [];
  isOpen.value = false;
  emit('update:modelValue', place.label);
  emit('item-select', place);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    isOpen.value = false;
    return;
  }
  if (event.key === 'ArrowDown' && suggestions.value.length) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length;
  } else if (event.key === 'ArrowUp' && suggestions.value.length) {
    event.preventDefault();
    activeIndex.value = (activeIndex.value - 1 + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (isOpen.value && suggestions.value.length) {
      selectPlace(suggestions.value[Math.max(0, activeIndex.value)]);
    } else if (inputValue.value.trim().length >= 3) {
      cancelSearch();
      isOpen.value = false;
      emit('text-submit', inputValue.value.trim());
    }
  } else if (event.key === 'Tab') {
    isOpen.value = false;
  }
}

onBeforeUnmount(() => {
  cancelSearch();
  clearTimeout(blurTimer);
});
</script>

<style scoped>
.address-search { position: relative; }
.address-search .field { padding-right: 2.4rem; }
/* The label leaves room for the clear button. */
.address-search > label { max-width: calc(100% - 3rem); }
.address-search__clear { position: absolute; top: 1.25rem; right: .35rem; display: grid; place-items: center; width: 1.75rem; height: 1.75rem;
  padding: 0; border: 0; border-radius: 50%; background: none; color: var(--text-muted); cursor: pointer; transform: translateY(-50%); }
.address-search__clear:hover { background: var(--surface-muted); color: var(--text); }
.address-search__loading { position: absolute; right: 2.5rem; top: .7rem; color: var(--text-muted); font-size: .75rem; }
.address-search__results, .address-search__feedback { position: absolute; z-index: 20; top: calc(100% + .25rem); left: 0; right: 0;
  max-height: 14rem; overflow: auto; margin: 0; padding: .3rem; list-style: none; }
.address-search__results li { cursor: pointer; border-radius: var(--radius); padding: .5rem .55rem; font-size: .85rem; }
.address-search__results li:hover, .address-search__results li.is-active { background: var(--accent-soft); }
.address-search__feedback { padding: .55rem .65rem; color: var(--text-muted); font-size: .82rem; }
.address-search__feedback[role=alert] { color: var(--danger); }
</style>
