// Picks a basemap through the map's "Kartenansicht" menu by keyboard, so a pointer hovering the map stays put.
export async function chooseBasemap(page, id) {
  const menu = page.getByRole('button', { name: 'Kartenansicht', exact: true });
  if (await menu.getAttribute('aria-expanded') !== 'true') {
    await menusGone(page);
    await menu.press('Enter');
  }
  const option = page.locator(`input[name=basemap][value="${id}"]`);
  // The menu shows its content after a short transition.
  await option.waitFor({ state: 'visible' });
  await option.focus();
  await option.press('Space');
  await closeMenus(page);
}

// A map menu reopened while still closing loses its content, so menus open only once the last one has gone.
const menusGone = page => page.waitForFunction(() => [...document.querySelectorAll('.map-menu__panel')].every(panel => !panel.offsetParent));
export async function closeMenus(page) {
  await page.keyboard.press('Escape');
  await menusGone(page);
}

// Opens a route from these points as a new route, as the planner's former example buttons did.
export async function openRoute(page, coords, shapeIndices = []) {
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('route'));
  await page.evaluate(([coords, shapeIndices]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route')
    .resetRoute(coords, shapeIndices), [coords, shapeIndices]);
}

// Track colours are segmented buttons: pick a mode, or read the chosen one.
export const trackColor = (page, mode) => page.getByRole('group', { name: 'Trackfarbe', exact: true }).locator(`[data-mode="${mode}"]`).click();
export const trackColorValue = page => page.getByRole('group', { name: 'Trackfarbe', exact: true }).locator('[aria-pressed=true]').getAttribute('data-mode');
