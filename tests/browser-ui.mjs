// Picks a basemap through the map's "Kartenansicht" menu by keyboard, so a pointer hovering the map stays put.
export async function chooseBasemap(page, id) {
  const menu = page.getByRole('button', { name: 'Kartenansicht', exact: true });
  if (await menu.getAttribute('aria-expanded') !== 'true') await menu.press('Enter');
  const option = page.locator(`input[name=basemap][value="${id}"]`);
  await option.focus();
  await option.press('Space');
  await option.press('Escape');
}
