import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.mjs';
import { readGoogleCredentials } from './google_auth.mjs';

test('Google credentials usam configurações de runtime criptografáveis antes do fallback legado', () => {
  const previous = {
    googleCalendarApiKey: config.googleCalendarApiKey,
    googleCalendarAccessToken: config.googleCalendarAccessToken,
    googleDriveAccessToken: config.googleDriveAccessToken,
    googleSheetsAccessToken: config.googleSheetsAccessToken,
    googleGmailAccessToken: config.googleGmailAccessToken
  };
  try {
    config.googleCalendarApiKey = 'calendar-panel-key';
    config.googleCalendarAccessToken = 'calendar-panel-token';
    config.googleDriveAccessToken = 'drive-panel-token';
    config.googleSheetsAccessToken = 'sheets-panel-token';
    config.googleGmailAccessToken = 'gmail-panel-token';

    assert.equal(readGoogleCredentials('GOOGLE_CALENDAR').apiKey, 'calendar-panel-key');
    assert.equal(readGoogleCredentials('GOOGLE_CALENDAR').accessToken, 'calendar-panel-token');
    assert.equal(readGoogleCredentials('GOOGLE_DRIVE').accessToken, 'drive-panel-token');
    assert.equal(readGoogleCredentials('GOOGLE_SHEETS').accessToken, 'sheets-panel-token');
    assert.equal(readGoogleCredentials('GOOGLE_GMAIL').accessToken, 'gmail-panel-token');
  } finally {
    Object.assign(config, previous);
  }
});
