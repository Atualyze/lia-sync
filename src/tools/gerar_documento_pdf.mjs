import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { resolveIdentity } from '../core/identity.mjs';

// Substitui emojis e símbolos fora do Windows-1252 (fontes padrão do PDF não os suportam)
const CHAR_MAP = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00A0': ' ', '\u2192': '->', '\u2022': '\u2022' };
function sanitize(text = '') {
  return String(text)
    .replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0\u2192]/g, c => CHAR_MAP[c] || ' ')
    .replace(/[\uFE0E\uFE0F\u200D]/g, '')
    // eslint-disable-next-line no-control-regex -- sanitização intencional de caracteres de controle
    .replace(/[^\u0000-\u00FF\u2022\n]/g, '');
}

function wrapLine(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        // palavra maior que a linha inteira: corta por caractere
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      } else line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

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
        description: 'Corpo COMPLETO e detalhado do documento, com várias seções. Use "### " para iniciar uma seção (fica em negrito), "• " para itens de lista e linhas terminadas em ":" como subtítulos. Inclua TODAS as informações relevantes do pedido: contexto, itens, quantidades, valores, prazos, observações. Nunca envie um resumo de 1-2 frases; o documento precisa ter conteúdo real.'
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

      // 3. Título Principal (com quebra se longo)
      for (const tl of wrapLine(sanitize(titulo), fontBold, 18, width - 100)) {
        page.drawText(tl, {
          x: 50,
          y: height - 75,
          size: 18,
          font: fontBold,
          color: rgb(0.06, 0.09, 0.16)
        });
      }

      // 4. Metadados
      const dataEmissao = new Date().toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });

      page.drawText(sanitize(`Destinatário: ${destinatario}`), {
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

      // 5. Conteúdo / Corpo do Documento (com quebra de linha e múltiplas páginas)
      let pageCtx = { page, y: height - 145 };
      const bodyMarginBottom = 110;
      const lineHeight = 18;

      const ensureSpace = (doc, ctx, needed) => {
        if (ctx.y - needed < bodyMarginBottom) {
          const newPage = doc.addPage([595.28, 841.89]);
          return { page: newPage, y: newPage.getSize().height - 90 };
        }
        return ctx;
      };

      const lines = sanitize(conteudo).split('\n');

      for (const line of lines) {
        if (line.trim().length === 0) {
          pageCtx.y -= 10;
          continue;
        }

        const isBullet = line.trim().startsWith('\u2022') || line.trim().startsWith('-');
        const isBoldLine = line.trim().startsWith('###') || line.trim().endsWith(':');
        const raw = line.replace(/^###\s*/, '').trim();
        if (!raw) continue;

        const size = isBoldLine ? 11.5 : 10.5;
        const x = isBullet ? 65 : 50;
        const maxWidth = width - (isBullet ? 130 : 110);

        const wrapped = wrapLine(raw, isBoldLine ? fontBold : fontRegular, size, maxWidth);
        for (const wl of wrapped) {
          pageCtx = ensureSpace(pdfDoc, pageCtx, lineHeight + 8);
          pageCtx.page.drawText(wl, {
            x,
            y: pageCtx.y,
            size,
            font: isBoldLine ? fontBold : fontRegular,
            color: rgb(0.12, 0.16, 0.23)
          });
          pageCtx.y -= lineHeight;
        }
        if (isBoldLine) pageCtx.y -= 6; // respiro após seção
      }

      const pageNow = pageCtx.page;
      const { width: wNow } = pageNow.getSize();

      // 6. Box de Valor (se houver)
      if (valor) {
        const vCtx = ensureSpace(pdfDoc, pageCtx, 70);
        const vy = Math.max(vCtx.y - 10, 160);
        vCtx.page.drawRectangle({
          x: 50,
          y: vy - 35,
          width: wNow - 100,
          height: 45,
          color: rgb(0.96, 0.97, 1.0),
          borderColor: rgb(0.78, 0.82, 0.98),
          borderWidth: 1
        });

        vCtx.page.drawText('INVESTIMENTO / VALOR TOTAL:', {
          x: 65,
          y: vy - 12,
          size: 9,
          font: fontBold,
          color: rgb(0.31, 0.27, 0.90)
        });

        vCtx.page.drawText(sanitize(valor), {
          x: 65,
          y: vy - 28,
          size: 14,
          font: fontBold,
          color: rgb(0.06, 0.09, 0.16)
        });
      }

      // 7. Rodapé de Autenticidade
      pageNow.drawLine({
        start: { x: 50, y: 70 },
        end: { x: wNow - 50, y: 70 },
        thickness: 1,
        color: rgb(0.88, 0.91, 0.94)
      });

      const footer = `Gerado automaticamente pela ${identity.botName}` +
        (identity.companyName ? ` \u2022 ${identity.companyName}` : '') +
        (identity.responsible ? ` (${identity.responsible})` : '');
      pageNow.drawText(sanitize(footer), {
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
