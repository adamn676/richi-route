import { createVuetify } from 'vuetify';
import { VBtn } from 'vuetify/components/VBtn';
import { md3 } from 'vuetify/blueprints';
import { de } from 'vuetify/locale';
import {
  IconAlertCircle, IconAlertTriangle, IconChevronLeft, IconChevronRight, IconCircle, IconCircleDotFilled, IconSquare,
  IconSquareCheckFilled, IconSquareMinusFilled, IconX,
} from '@/components/icons';
import { routeStyle } from '@/config/mapStyle';

// Material 3 through Vuetify, in the planner's colours: the green of paved roads on the map, compact controls for the sidebar,
// and Vuetify's own icons drawn from the Tabler set the planner uses everywhere else. main.css takes its colours from here.
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
          primary: routeStyle.paved, secondary: '#4d6357', background: '#eef1f0', surface: '#fcfcfb', 'surface-variant': '#dde3e1',
          'on-background': '#17262a', 'on-surface': '#17262a', 'on-surface-variant': '#56676b', error: '#a3261b', warning: '#7a5200',
        },
        // Field labels, hints and placeholders reach a contrast of 4.5:1; hover shows with Material 3's state layer.
        variables: { 'medium-emphasis-opacity': 0.75, 'hover-opacity': 0.08 },
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
    // Tabs are buttons inside; their press and hover layers fill the square tab, not the blueprint's rounded button.
    VTab: { rounded: 0 },
    VList: { density: 'compact' },
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
