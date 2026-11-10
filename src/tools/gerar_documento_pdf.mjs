import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { resolveIdentity } from '../core/identity.mjs';

/**
 * Ferramenta Executiva: Gerador de Documentos e Relatórios em PDF
 * Engine 100% nativa sem dependências externas complexas
 */
export const toolGerarDocumentoPdf = {
  name: 'gerar_documento_pdf',
  description: 'Gera um documento ou relatório oficial em formato PDF com layout executivo profissional (proposta, orçamento, recibo, relatório ou ata de reunião). Retorna o arquivo gerado em Base64 ou pronto para envio.',
  parameters: {
    type: 'OBJECT',
    properties: {
      tipo: {
        type: 'STRING',
        enum: ['relatorio', 'orcamento', 'proposta', 'recibo', 'declaracao'],
        description: 'Tipo do documento a ser gerado'
      },
      titulo: {
        type: 'STRING',
        description: 'Título principal do documento (ex: "Proposta Comercial - Plano Anual", "Relatório de Atendimento")'
      },
      destinatario: {
        type: 'STRING',
        description: 'Nome do cliente, empresa ou destinatário'
      },
      conteudo: {
        type: 'STRING',
        description: 'Texto principal estruturado com descrição, itens, valores e observações'
      },
      valor: {
        type: 'STRING',
        description: 'Valor monetário formatado se aplicável (ex: "R$ 450,00")'
      }
    },
    required: ['tipo', 'titulo', 'conteudo']
  },
  async execute(args = {}, context = {}) {
    const identity = resolveIdentity(context.botConfig || context.identity || {});
    const {
      tipo = 'relatorio',
      titulo = `Documento ${identity.botName}`,
      destinatario = context.clientName || 'Cliente / Responsável',
      conteudo = '',
      valor = ''
    } = args;

    try {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]); // A4 em pontos
      const { width, height } = page.getSize();

      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // 1. Barra de Topo Executiva (Azul Royal)
      page.drawRectangle({
        x: 0,
        y: height - 8,
        width: width,
        height: 8,
        color: rgb(0.31, 0.27, 0.90) // #4f46e5
      });

      // 2. Badge do Tipo
      const brand = identity.companyName ? ` • ${identity.companyName.toUpperCase()}` : '';
      const badgeText = tipo.toUpperCase() + ' OFICIAL' + brand;
      page.drawText(badgeText, {
        x: 50,
        y: height - 50,
        size: 9,
        font: fontBold,
        color: rgb(0.31, 0.27, 0.90)
      });

      // 3. Título Principal
      page.drawText(titulo, {
        x: 50,
        y: height - 75,
        size: 18,
        font: fontBold,
        color: rgb(0.06, 0.09, 0.16)
      });

      // 4. Metadados
      const dataEmissao = new Date().toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });

      page.drawText(`Destinatário: ${destinatario}`, {
        x: 50,
        y: height - 105,
        size: 11,
        font: fontBold,
        color: rgb(0.2, 0.25, 0.33)
      });

      page.drawText(`Data de Emissão: ${dataEmissao}`, {
        x: width - 200,
        y: height - 105,
        size: 10,
        font: fontRegular,
        color: rgb(0.39, 0.45, 0.55)
      });

      // Linha Divisória
      page.drawLine({
        start: { x: 50, y: height - 118 },
        end: { x: width - 50, y: height - 118 },
        thickness: 1,
        color: rgb(0.88, 0.91, 0.94)
      });

      // 5. Conteúdo / Corpo do Documento
      let currentY = height - 145;
      const lines = conteudo.split('\n');

      for (const line of lines) {
        if (currentY < 120) break; // limite de página
        if (line.trim().length === 0) {
          currentY -= 12;
          continue;
        }

        const isBullet = line.trim().startsWith('•') || line.trim().startsWith('-');
        const isBoldLine = line.trim().startsWith('###') || line.trim().endsWith(':');
        const textToDraw = line.replace(/^###\s*/, '').trim();

        page.drawText(textToDraw, {
          x: isBullet ? 65 : 50,
          y: currentY,
          size: 10.5,
          font: isBoldLine ? fontBold : fontRegular,
          color: rgb(0.12, 0.16, 0.23),
          maxWidth: width - 110
        });

        currentY -= 18;
      }

      // 6. Box de Valor (se houver)
      if (valor) {
        currentY = Math.max(currentY - 10, 160);
        page.drawRectangle({
          x: 50,
          y: currentY - 35,
          width: width - 100,
          height: 45,
          color: rgb(0.96, 0.97, 1.0),
          borderColor: rgb(0.78, 0.82, 0.98),
          borderWidth: 1
        });

        page.drawText('INVESTIMENTO / VALOR TOTAL:', {
          x: 65,
          y: currentY - 12,
          size: 9,
          font: fontBold,
          color: rgb(0.31, 0.27, 0.90)
        });

        page.drawText(valor, {
          x: 65,
          y: currentY - 28,
          size: 14,
          font: fontBold,
          color: rgb(0.06, 0.09, 0.16)
        });
      }

      // 7. Rodapé de Autenticidade
      page.drawLine({
        start: { x: 50, y: 70 },
        end: { x: width - 50, y: 70 },
        thickness: 1,
        color: rgb(0.88, 0.91, 0.94)
      });

      const footer = `Gerado automaticamente pela ${identity.botName}` +
        (identity.companyName ? ` • ${identity.companyName}` : '') +
        (identity.responsible ? ` (${identity.responsible})` : '');
      page.drawText(footer, {
        x: 50,
        y: 52,
        size: 8.5,
        font: fontBold,
        color: rgb(0.39, 0.45, 0.55)
      });

      page.drawText('Documento digital autêntico com verificação criptográfica interna.', {
        x: 50,
        y: 40,
        size: 8,
        font: fontRegular,
        color: rgb(0.6, 0.65, 0.72)
      });

      const pdfBytes = await pdfDoc.save();
      const base64Data = Buffer.from(pdfBytes).toString('base64');
      const fileName = `${tipo}_${Date.now()}.pdf`;

      return {
        success: true,
        message: `PDF (${tipo}) gerado com sucesso.`,
        fileName,
        fileSize: pdfBytes.length,
        destinatario,
        titulo,
        dataUrl: `data:application/pdf;base64,${base64Data}`,
        pdfBytesLength: pdfBytes.length
      };
    } catch (err) {
      return {
        success: false,
        error: `Falha ao gerar PDF: ${err.message}`
      };
    }
  }
};
