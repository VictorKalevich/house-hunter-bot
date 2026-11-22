import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePolyline, encodePolyline } from '../../src/geo/polyline.js';

test('эталон алгоритма Google (точность 5)', () => {
  const points = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]];
  assert.equal(encodePolyline(points), '_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), points);
});

test('кодирование и декодирование — туда и обратно (Минск)', () => {
  const pts = [[53.90454, 27.56152], [53.9, 27.6], [53.85, 27.4], [53.95, 27.7]];
  assert.deepEqual(decodePolyline(encodePolyline(pts)), pts);
  assert.deepEqual(decodePolyline(''), []);
});
