import test from 'node:test';
import assert from 'node:assert/strict';
import { toolGerarDocumentoPdf } from './tools/gerar_documento_pdf.mjs';

test('pdfme tool: gera PDF oficial com parâmetros válidos', async () => {
  const res = await toolGerarDocumentoPdf.execute({
    tipo: 'proposta',
    titulo: 'Proposta Comercial - Atualyze Intelligence',
    destinatario: 'Cliente Teste',
    conteudo: 'Item 1: Consultoria em IA\nItem 2: Implantação Lia Bot',
    valor: 'R$ 1.500,00'
  });

  assert.equal(res.success, true);
  assert.ok(res.fileSize > 1000, 'Arquivo PDF deve ter tamanho válido');
  assert.ok(res.dataUrl.startsWith('data:application/pdf;base64,'), 'Deve gerar data URL base64');
  assert.equal(res.destinatario, 'Cliente Teste');
});

test('pdfme tool: sanitiza emojis e quebra linhas longas em múltiplas páginas', async () => {
  const paragrafo = 'Linha executiva extremamente longa. '.repeat(30);
  const res = await toolGerarDocumentoPdf.execute({
    tipo: 'relatorio',
    titulo: 'Relatório 🚀 com emoji e texto muito longo para testar a quebra automática de linha do gerador',
    destinatario: 'Tauan',
    conteudo: `### Seção Um 🟢\n${paragrafo}\n\n### Seção Dois\n• item com emoji 📱\n- item normal\n${paragrafo}`
  });

  assert.equal(res.success, true, res.error);
  assert.ok(res.fileSize > 1000);
  const fs = await import('node:fs');
  const bytes = Buffer.from(res.dataUrl.split(',')[1], 'base64');
  assert.equal(bytes.slice(0, 5).toString(), '%PDF-');
});
