import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGpxTrack } from '../src/domain/gpx-track.ts';
import { cumulativeAscent, routerClimbThreshold } from '../src/domain/route-model.ts';
import { gpxSections, sectionSurfaces } from '../src/domain/gpx-route.ts';
import { isRoutingPolicyCurrent } from '../src/config/routing-policy.ts';

// About 111 m per step northwards.
const line = (count, elevation = i => 300 + i) => ({ name: '', coordinates: Array.from({ length: count }, (_, i) => [15, 47 + i / 1000]),
  elevations: Array.from({ length: count }, (_, i) => elevation(i)) });

test('a track opens as sections of about 5 km that keep its exact path and heights', () => {
  const track = buildGpxTrack('Runde', 'runde.gpx', [line(200)]);
  const [sections] = gpxSections(track);
  assert.equal(sections.length, 4);
  assert.ok(sections.slice(0, -1).every(section => section.distanceMeters >= 5000 && section.distanceMeters < 5200));
  assert.ok(sections.at(-1).distanceMeters >= 2500, 'No short remainder at the end');
  sections.slice(1).forEach((section, i) => assert.deepEqual(section.coordinates[0], sections[i].coordinates.at(-1)));
  assert.deepEqual(sections.flatMap((section, i) => i ? section.coordinates.slice(1) : section.coordinates), track.segments[0].coordinates);
  assert.deepEqual(sections.flatMap((section, i) => i ? section.elevations.slice(1) : section.elevations), track.segments[0].elevations);
  assert.ok(Math.abs(sections.reduce((sum, section) => sum + section.distanceMeters, 0) - track.distanceMeters) < 1e-6);
  assert.ok(sections.every(section => isRoutingPolicyCurrent(section.routingPolicy) && section.segment === 0 && section.recorded));
});

test('short tracks stay one section; missing heights leave a section without ascent; empty segments are skipped', () => {
  const track = buildGpxTrack('Kurz', 'kurz.gpx', [line(20, i => i === 5 ? null : 300), line(1)]);
  const sections = gpxSections(track);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].length, 1);
  assert.equal(sections[0][0].elevations, null);
  assert.equal(sections[0][0].ascentMeters, null);
});

test('surfaces found for a track segment are cut to each section', () => {
  const track = buildGpxTrack('Runde', 'runde.gpx', [line(200)]);
  const [sections] = gpxSections(track);
  const second = sections[1];
  const spans = [{ fromIndex: 10, toIndex: second.from + 3, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: second.from + 3, toIndex: second.from + 60, surface: 'unpaved', surfaceTag: 'gravel' }];
  assert.deepEqual(sectionSurfaces(second, spans), [
    { fromIndex: 0, toIndex: 3, surface: 'paved', surfaceTag: 'asphalt' },
    { fromIndex: 3, toIndex: second.coordinates.length - 1, surface: 'unpaved', surfaceTag: 'gravel' },
  ]);
  assert.deepEqual(sectionSurfaces(sections[3], spans), []);
});

test('ascent ignores small up-and-down noise but counts real climbs; sections add up to the track', () => {
  assert.equal(cumulativeAscent([300, 301.5, 300, 301.8, 300.4, 301.9, 300.6]).at(-1), 0);
  assert.equal(cumulativeAscent([300, 303, 300, 304, 301, 303, 300], routerClimbThreshold).at(-1), 0, 'Router heights wobble more');
  assert.deepEqual(cumulativeAscent([300, 310, 320, 319, 330]), [0, 10, 20, 20, 30], 'Climbs count in full, across small dips');
  assert.deepEqual(cumulativeAscent([300, 301, 303, 301, 304]), [0, 0, 3, 3, 4], 'A climb counts from its low once it passes the threshold');
  assert.equal(cumulativeAscent([300, 320, null, 330, 350]).at(-1), 40, 'Each run between missing heights is filtered on its own');
  const track = buildGpxTrack('Wellen', 'wellen.gpx', [line(200, i => 300 + 40 * Math.sin(i / 7) + (i % 3))]);
  const total = gpxSections(track)[0].reduce((sum, section) => sum + section.ascentMeters, 0);
  assert.ok(Math.abs(total - track.ascentMeters) < 1e-9);
});
