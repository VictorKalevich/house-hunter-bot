// Encoded polyline (алгоритм Google), точность 5 знаков — как у ORS и OSRM (research.md R3).

/** @returns {Array<[number, number]>} точки [lat, lon] */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (let axis = 0; axis < 2; axis++) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

/** @param {Array<[number, number]>} points [lat, lon] */
export function encodePolyline(points, precision = 5) {
  const factor = 10 ** precision;
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lat, lon] of points) {
    const iLat = Math.round(lat * factor);
    const iLon = Math.round(lon * factor);
    out += encodeValue(iLat - prevLat) + encodeValue(iLon - prevLon);
    prevLat = iLat;
    prevLon = iLon;
  }
  return out;
}

function encodeValue(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}
