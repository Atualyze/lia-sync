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
