// Picks a basemap through the map's "Kartenansicht" menu by keyboard, so a pointer hovering the map stays put.
export async function chooseBasemap(page, id) {
  const menu = page.getByRole('button', { name: 'Kartenansicht', exact: true });
  if (await menu.getAttribute('aria-expanded') !== 'true') await menu.press('Enter');
  const option = page.locator(`input[name=basemap][value="${id}"]`);
  await option.focus();
  await option.press('Space');
  await option.press('Escape');
}

// Opens a route from these points as a new route, as the planner's former example buttons did.
export async function openRoute(page, coords, shapeIndices = []) {
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('route'));
  await page.evaluate(([coords, shapeIndices]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('route')
    .resetRoute(coords, shapeIndices), [coords, shapeIndices]);
}
