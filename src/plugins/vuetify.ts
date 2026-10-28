import { createVuetify } from 'vuetify';
import { VBtn } from 'vuetify/components/VBtn';
import { md3 } from 'vuetify/blueprints';
import { de } from 'vuetify/locale';
import {
  IconAlertCircle, IconAlertTriangle, IconChevronLeft, IconChevronRight, IconCircle, IconCircleDotFilled, IconSquare,
  IconSquareCheckFilled, IconSquareMinusFilled, IconX,
} from '@/components/icons';

// Material 3 through Vuetify, in the planner's colours: light grey surfaces and the markers' dark ink, which leave colour to
// the route and its surfaces on the map; compact controls for the sidebar, and Vuetify's own icons drawn from the Tabler
// set the planner uses everywhere else. main.css takes its colours from here.
export const vuetify = createVuetify({
  blueprint: md3,
  locale: { locale: 'de', messages: { de } },
  // Phones and narrow windows, as in the stylesheets' 760 px queries.
  display: { mobileBreakpoint: 761 },
  // The map's floating tool buttons and the panels' icon buttons each share one look.
  aliases: { VMapButton: VBtn, VIconButton: VBtn },
  theme: {
    defaultTheme: 'planner',
    themes: {
      planner: {
        dark: false,
        colors: {
          primary: '#1c2421', secondary: '#4d5753', background: '#f6f7f7', surface: '#ffffff', 'surface-variant': '#e6e9e8',
          'on-background': '#121816', 'on-surface': '#121816', 'on-surface-variant': '#5b6562', error: '#a3261b', warning: '#7a5200',
          'inverse-surface': '#1c2421', 'inverse-primary': '#8fdcb8',
        },
        // Field labels, hints and placeholders reach a contrast of 4.5:1; hover shows with Material 3's state layer.
        variables: { 'medium-emphasis-opacity': 0.75, 'hover-opacity': 0.06 },
      },
    },
  },
  defaults: {
    // No field shows messages, so none keeps room for them.
    global: { hideDetails: true },
    VTextField: { density: 'compact' },
    VCombobox: { density: 'compact' },
    VCheckbox: { color: 'primary', density: 'compact' },
    VSwitch: { color: 'primary', density: 'compact', inset: true },
    VTabs: { grow: true },
    // Segmented tabs (AppSidebar): rounded, without a ripple, since the sliding field shows the choice.
    VTab: { rounded: 'lg', ripple: false },
    VList: { density: 'compact' },
    // Half a second's rest before a tooltip; plugins/tooltips.ts shortens it right after one has shown.
    VTooltip: { openDelay: 500 },
    // Confirmations of one's own actions, in Material's inverse colours: neither a warning nor an error, set apart from the
    // panel and the map; they appear at the panel's foot, which they report on.
    VSnackbar: { color: 'inverse-surface', attach: '#sidebar', contained: true, rounded: 'lg' },
    VAlert: { variant: 'tonal', density: 'compact', VBtn: { variant: 'outlined', size: 'small' } },
    VMapButton: { icon: true, size: 40, rounded: 'lg', elevation: 2, color: 'surface' },
    VIconButton: { icon: true, variant: 'text', size: 'small', color: 'on-surface-variant' },
  },
  icons: {
    aliases: {
      prev: IconChevronLeft, next: IconChevronRight, clear: IconX, warning: IconAlertTriangle, error: IconAlertCircle,
      checkboxOn: IconSquareCheckFilled, checkboxOff: IconSquare, checkboxIndeterminate: IconSquareMinusFilled,
      radioOn: IconCircleDotFilled, radioOff: IconCircle,
    },
  },
});
