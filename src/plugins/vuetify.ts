import { createVuetify } from 'vuetify';
import { VBtn } from 'vuetify/components/VBtn';
import { md3 } from 'vuetify/blueprints';
import { de } from 'vuetify/locale';
import { IconAlertCircle, IconAlertTriangle, IconChevronLeft, IconChevronRight, IconX } from '@/components/icons';

// Checkboxes and radio buttons keep Material's own shapes (Material Design Icons, Apache 2.0): they are controls people
// know by that shape, not icons of the planner's Tabler set.
const square = 'M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3';
const ring = 'M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2';

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
    VTextField: { density: 'compact', variant: 'underlined' },
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
      checkboxOn: `svg:M10,17L5,12L6.41,10.58L10,14.17L17.59,6.58L19,8M${square.slice(1)}Z`, checkboxOff: `svg:${square}M19,5V19H5V5H19Z`,
      checkboxIndeterminate: `svg:M17,13H7V11H17M${square.slice(1)}Z`,
      radioOn: `svg:${ring}M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7Z`, radioOff: `svg:${ring}Z`,
    },
  },
});
