import { test } from 'node:test';
import assert from 'node:assert/strict';

// install.js usa window solo para el evento de instalación; se simula lo mínimo.
globalThis.window = { addEventListener() {} };
globalThis.location = { origin: 'https://selah.orbitix.app' };
const { detect, GUIDES, installText } = await import('../public/js/install.js');

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  iphoneWhatsApp: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp',
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
};

test('detecta sistema y navegador sin asumir Chrome', () => {
  assert.deepEqual(detect(UA.iphoneSafari, 5), { os: 'ios', browser: 'safari' });
  assert.deepEqual(detect(UA.iphoneChrome, 5), { os: 'ios', browser: 'chrome' });
  assert.deepEqual(detect(UA.iphoneWhatsApp, 5), { os: 'ios', browser: 'inapp' });
  assert.deepEqual(detect(UA.ipad, 5), { os: 'ios', browser: 'safari' });
  assert.deepEqual(detect(UA.ipad, 0), { os: 'desktop', browser: 'safari' });
  assert.deepEqual(detect(UA.samsung, 5), { os: 'android', browser: 'samsung' });
  assert.deepEqual(detect(UA.androidChrome, 5), { os: 'android', browser: 'chrome' });
  assert.deepEqual(detect(UA.androidFirefox, 5), { os: 'android', browser: 'firefox' });
});

test('cada navegador detectado tiene pasos', () => {
  for (const ua of Object.values(UA)) {
    const d = detect(ua, 5);
    assert.ok(GUIDES[d.os][d.browser]?.steps.length, `${d.os}/${d.browser}`);
  }
});

test('el mensaje de WhatsApp cubre iPhone y Android', () => {
  const t = installText();
  assert.match(t, /iPhone/);
  assert.match(t, /Safari/);
  assert.match(t, /Android/);
  assert.match(t, /Samsung Internet/);
  assert.match(t, /\?instalar/);
});
