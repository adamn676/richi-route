// The positions recorded in a FIT activity file (Garmin's Flexible and Interoperable Data Transfer), in order: the
// latitude and longitude fields of its "record" messages. Everything else is skipped by the sizes its definitions give.
const recordMessage = 20, latitudeField = 0, longitudeField = 1;
const missing = 0x7fffffff;
const degrees = semicircles => semicircles * 180 / 2 ** 31;

export function fitPositions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = [];
  // A file may hold several FIT files one after another.
  for (let start = 0; start + 12 <= bytes.length;) {
    const headerSize = bytes[start];
    if (headerSize < 12 || String.fromCharCode(...bytes.subarray(start + 8, start + 12)) !== '.FIT') throw new Error('Not a FIT file');
    const end = start + headerSize + view.getUint32(start + 4, true);
    if (end > bytes.length) throw new Error('FIT file cut short');
    const definitions = [];
    for (let at = start + headerSize; at < end;) {
      const header = bytes[at++];
      // Compressed timestamp headers carry a data message of local type 0–3.
      const local = header & 0x80 ? header >> 5 & 3 : header & 15;
      if (!(header & 0x80) && header & 0x40) {
        const littleEndian = bytes[at + 1] === 0, message = view.getUint16(at + 2, littleEndian), count = bytes[at + 4];
        at += 5;
        const fields = [];
        for (let i = 0; i < count; i++, at += 3) fields.push({ number: bytes[at], size: bytes[at + 1] });
        let size = fields.reduce((sum, field) => sum + field.size, 0);
        if (header & 0x20) {
          const developer = bytes[at++];
          for (let i = 0; i < developer; i++, at += 3) size += bytes[at + 1];
        }
        definitions[local] = { message, littleEndian, fields, size };
        continue;
      }
      const definition = definitions[local];
      if (!definition) throw new Error('FIT data before its definition');
      if (definition.message === recordMessage) {
        let latitude = missing, longitude = missing;
        for (let i = 0, field = at; i < definition.fields.length; field += definition.fields[i++].size) {
          const { number, size } = definition.fields[i];
          if (size !== 4) continue;
          if (number === latitudeField) latitude = view.getInt32(field, definition.littleEndian);
          else if (number === longitudeField) longitude = view.getInt32(field, definition.littleEndian);
        }
        if (latitude !== missing && longitude !== missing) positions.push([degrees(longitude), degrees(latitude)]);
      }
      at += definition.size;
    }
    start = end + 2;
  }
  return positions;
}
