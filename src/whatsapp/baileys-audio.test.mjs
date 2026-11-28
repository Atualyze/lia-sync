import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWhatsAppAudioPayload } from './baileys-provider.mjs';

test('resolveWhatsAppAudioPayload mantém OggS como nota de voz Opus (ptt: true)', async () => {
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 2, 0, 0])]);
  const res = await resolveWhatsAppAudioPayload(ogg, {
    transcode: async () => {
      throw new Error('não deve transcodificar OggS');
    }
  });
  assert.equal(res.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(res.ptt, true);
  assert.equal(res.audio, ogg);
});

test('resolveWhatsAppAudioPayload converte MP3/WAV para Ogg Opus PTT quando transcode funciona', async () => {
  const mp3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00');
  const fakeOgg = Buffer.from('OggS-transcoded');
  const res = await resolveWhatsAppAudioPayload(mp3, {
    transcode: async () => fakeOgg
  });
  assert.equal(res.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(res.ptt, true);
  assert.equal(res.audio, fakeOgg);
});

test('resolveWhatsAppAudioPayload nunca rotula MP3 ou WAV como Ogg Opus quando ffmpeg falha', async () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const mp3Res = await resolveWhatsAppAudioPayload(mp3, { transcode: async () => null });
  assert.equal(mp3Res.mimetype, 'audio/mpeg');
  assert.equal(mp3Res.ptt, false);

  const wav = Buffer.from('RIFF\x24\x00\x00\x00WAVE');
  const wavRes = await resolveWhatsAppAudioPayload(wav, { transcode: async () => null });
  assert.equal(wavRes.mimetype, 'audio/wav');
  assert.equal(wavRes.ptt, false);
});
