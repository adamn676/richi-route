"""Convert water and bicycle-service nodes/ways from a local OSM PBF to setup input."""
import argparse
import json
import osmium

parser = argparse.ArgumentParser()
parser.add_argument('file')
parser.add_argument('output')
parser.add_argument('--coverage', required=True)
args = parser.parse_args()
processor = osmium.FileProcessor(args.file, entities=osmium.osm.NODE | osmium.osm.WAY).with_filter(
    osmium.filter.TagFilter(('amenity', 'drinking_water'), ('drinking_water', 'yes'),
                           ('amenity', 'bicycle_repair_station'), ('shop', 'bicycle'),
                           ('railway', 'station'), ('railway', 'halt')))
updated = processor.header.get('osmosis_replication_timestamp')
if not updated:
    raise ValueError('OSM extract has no data timestamp')
elements, ways, references = [], [], set()
for obj in processor:
    element = {'id': obj.id, 'tags': dict(obj.tags)}
    if obj.is_node():
        if obj.location.valid():
            elements.append({**element, 'type': 'node', 'lon': obj.lon, 'lat': obj.lat})
    else:
        nodes = [node.ref for node in obj.nodes]
        references.update(nodes)
        ways.append((element, nodes))
locations = {}
if references:
    for node in osmium.FileProcessor(args.file, entities=osmium.osm.NODE).with_filter(osmium.filter.IdFilter(references)):
        if node.location.valid():
            locations[node.id] = (node.lon, node.lat)
for element, nodes in ways:
    if nodes and all(node in locations for node in nodes):
        lons, lats = zip(*(locations[node] for node in nodes))
        elements.append({**element, 'type': 'way', 'center': {
            'lon': (min(lons) + max(lons)) / 2, 'lat': (min(lats) + max(lats)) / 2}})
with open(args.output, 'w') as output:
    json.dump({'osm3s': {'timestamp_osm_base': updated}, 'coverage': args.coverage, 'elements': elements}, output)
print(f'Extracted {len(elements)} cycling points and ways ({updated}).')
