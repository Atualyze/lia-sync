import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizarJanelaDeAtendimento, avaliarJanelaDeAtendimento } from './business-hours.mjs';
import { classificarSetorPorTexto } from './triage-router.mjs';

test('business-hours: normalizarJanelaDeAtendimento fail-open se desativado ou inválido', () => {
  assert.equal(normalizarJanelaDeAtendimento(null), null);
  assert.equal(normalizarJanelaDeAtendimento({ enabled: false }), null);
  assert.equal(normalizarJanelaDeAtendimento({ enabled: true, start: '18:00', end: '08:00' }), null); // fim <= inicio
  assert.equal(normalizarJanelaDeAtendimento({ enabled: true, timezone: 'Fuso/Invalido' }), null);
});

test('business-hours: avalia corretamente dentro e fora do horário', () => {
  const config = {
    enabled: true,
    timezone: 'America/Sao_Paulo',
    start: '08:00',
    end: '18:00',
    weekdays: [1, 2, 3, 4, 5], // Seg a Sex
    outOfHoursNotice: 'Nosso horário é {horario}. Retornaremos em breve.'
  };

  // Segunda-feira às 14:30 (dentro do horário)
  // Nota: 2026-11-09 é uma segunda-feira. 14:30 SP (UTC-3) = 17:30 UTC
  const segDentro = new Date('2026-11-09T17:30:00.000Z');
  const resDentro = avaliarJanelaDeAtendimento(config, segDentro);
  assert.equal(resDentro.isOpen, true);

  // Segunda-feira às 22:30 (fora do horário)
  // 22:30 SP (UTC-3) = 2026-11-10T01:30:00.000Z
  const segNoite = new Date('2026-11-10T01:30:00.000Z');
  const resNoite = avaliarJanelaDeAtendimento(config, segNoite);
  assert.equal(resNoite.isOpen, false);
  assert.ok(resNoite.noticeText.includes('08:00 às 18:00'));
  assert.ok(resNoite.msAteAbrir > 0);
  assert.ok(resNoite.periodoFechadoId.startsWith('closed_'));

  // Domingo às 10:00 (fora do horário)
  // 2026-11-08 é domingo. 10:00 SP = 13:00 UTC
  const domDia = new Date('2026-11-08T13:00:00.000Z');
  const resDom = avaliarJanelaDeAtendimento(config, domDia);
  assert.equal(resDom.isOpen, false);
  assert.ok(resDom.msAteAbrir > 0);
});

test('triage-router: classifica corretamente palavras-chave por setor', () => {
  const mockSectors = [
    { id: 'sec_vendas', name: 'Comercial & Vendas', description: 'Planos e propostas', isActive: true },
    { id: 'sec_suporte', name: 'Suporte Técnico', description: 'Erros e dúvidas', isActive: true },
    { id: 'sec_fin', name: 'Financeiro', description: 'Boletos e notas', isActive: true },
    { id: 'sec_dir', name: 'Tauan / Diretoria', description: 'Assuntos diretos', isActive: true }
  ];

  const t1 = classificarSetorPorTexto('Qual o valor do plano e quanto custa a adesão?', mockSectors);
  assert.equal(t1.category, 'vendas');
  assert.equal(t1.sectorId, 'sec_vendas');

  const t2 = classificarSetorPorTexto('Estou com um erro no sistema e não consigo fazer login', mockSectors);
  assert.equal(t2.category, 'suporte');
  assert.equal(t2.sectorId, 'sec_suporte');

  const t3 = classificarSetorPorTexto('Poderia me enviar a segunda via do boleto para pagamento por pix?', mockSectors);
  assert.equal(t3.category, 'financeiro');
  assert.equal(t3.sectorId, 'sec_fin');

  const t4 = classificarSetorPorTexto('Preciso falar urgente com o Tauan', mockSectors);
  assert.equal(t4.category, 'tauan');
  assert.equal(t4.sectorId, 'sec_dir');

  const t5 = classificarSetorPorTexto('Olá, boa tarde!', mockSectors);
  assert.equal(t5.category, null);
  assert.equal(t5.sectorId, null);
});
