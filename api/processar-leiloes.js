/**
 * DataRoht — Processador de Leilões SPY
 * Endpoint: POST /api/processar-leiloes
 *
 * Variáveis de ambiente no Vercel:
 *   ANTHROPIC_API_KEY  — chave da API da Anthropic
 *
 * Instalar no projeto Vercel:
 *   npm install xlsx @anthropic-ai/sdk busboy
 */

import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";
import busboy from "busboy";

export const config = { api: { bodyParser: false } };

// ─── Índices das colunas no Excel SPY ───────────────────────────────────────
const COL = {
  titulo: 0, estado: 1, cidade: 2, processo: 3, link: 4,
  preco1: 5, preco2: 6, data1: 7, data2: 8,
  area: 9, endereco: 10, tipo: 11, leiloeiro: 12, tipoBem: 13,
  avaliacao: 14,   // "Valor de Avaliação do Leiloeiro" = avaliação da fração diretamente
  financiamento: 15, parcelamento: 16, fgts: 17,
  ocupado: 18, matricula: 19, divCond: 20, divIptu: 21, debFid: 22,
  descricao: 23,
};

// ─── Fase 1: Filtro por Regex ─────────────────────────────────────────────────
const POSITIVOS = [
  /fra[çc][aã]o\s+ideal\s+(de\s+)?(\d+[,.]\d+\s*%|\d+\/\d+)/i,
  /parte\s+ideal\s+(de\s+)?(\d+[,.]\d+\s*%|\d+\/\d+)/i,
  /parte\s+indivisa/i,
  /\b(\d+\/\d+)\s*(avos?\s+)?(do\s+im[oó]vel|da\s+propriedade|dos\s+direitos?|da\s+meação)/i,
  /\b(\d+[,.]\d+|\d{2,3})\s*%\s*(do\s+im[oó]vel|da\s+propriedade|dos\s+direitos?|de\s+participa[çc][aã]o)/i,
  /\b(\d+[,.]\d+|\d{2,3})\s*%\s+de\s+(0?1\s*\(|um\s+|uma\s+)/i,
  /direitos?\s+(hereditários?|sobre\s+o\s+im[oó]vel|de\s+copropriedade)/i,
  /\bmeação\b/i,
  /quinhão\s+hereditário/i,
  /cota[- ]?parte\s+de\s+\d/i,
  /^a?\s*fra[çc][aã]o\s+ideal\s+de/i,
];

const NEGATIVOS = [
  /fra[çc][aã]o\s+(ideal\s+)?(de\s+)?\d+[/,]\d+\.?\d*\s*(do\s+terreno|de\s+terreno)/i,
  /entrada\s+de\s+\d+\s*%|parcelas?\s+de\s+\d+\s*%/i,
  /\d+[,.]\d+\s*%\s*\(?\s*de\s+desconto/i,
  /fra[çc][aã]o\s+do\s+terreno\s+de\s+\d+[/,]\d+/i,
];

function fase1Regex(rows) {
  const candidatos = [];
  for (const row of rows) {
    const texto = `${row[COL.titulo] || ""} ${row[COL.descricao] || ""}`;
    if (NEGATIVOS.some((r) => r.test(texto))) continue;
    const match = POSITIVOS.find((r) => r.test(texto));
    if (match) candidatos.push({ row, matchRegex: texto.match(match)?.[0] || "" });
  }
  return candidatos;
}

// ─── Fase 2: Validação e enriquecimento por IA ───────────────────────────────
const SYSTEM_PROMPT = `Você é especialista em leilões judiciais e extrajudiciais de imóveis no Brasil.

CRITÉRIO — É FRAÇÃO:
Fração = uma PARTE do imóvel sendo leiloada (copropriedade), não o imóvel inteiro.
✓ "50% de um apartamento", "1/3 do imóvel", "fração ideal de 25%", direitos hereditários, meação
✗ Imóvel inteiro, "entrada de 25%", "desconto de 46%", "fração de 337/1.000.000 do terreno" (técnico de matrícula)

Responda SOMENTE com JSON válido:
{
  "resultados": [
    {
      "id": <número>,
      "eUmLeilaoFracao": true/false,
      "fracaoQtd": "50%" ou "1/3" ou null,
      "observacoes": "frase curta e objetiva para o time de compras",
      "confianca": "alta" | "media" | "baixa"
    }
  ]
}`;

async function fase2IA(candidatos, client) {
  const BATCH = 30;
  const confirmados = [];
  const rejeitados = [];

  for (let i = 0; i < candidatos.length; i += BATCH) {
    const lote = candidatos.slice(i, i + BATCH);
    const linhas = lote.map((item, idx) => {
      const r = item.row;
      const desc = String(r[COL.descricao] || "").slice(0, 500);
      return `--- LEILÃO ${i + idx} ---\nTÍTULO: ${r[COL.titulo] || ""}\nDESCRIÇÃO: ${desc}`;
    });

    let parsed;
    try {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Classifique:\n\n${linhas.join("\n\n")}` }],
      });
      const texto = resp.content[0].text.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(texto);
    } catch (e) {
      lote.forEach((item) => {
        item.ia = { eUmLeilaoFracao: true, confianca: "baixa", observacoes: `erro IA: ${e.message?.slice(0, 50)}` };
        confirmados.push(item);
      });
      continue;
    }

    const mapa = Object.fromEntries(parsed.resultados.map((r) => [r.id, r]));
    lote.forEach((item, idx) => {
      const res = mapa[i + idx];
      item.ia = res || { eUmLeilaoFracao: true, confianca: "baixa", observacoes: "sem resposta" };
      (res?.eUmLeilaoFracao !== false ? confirmados : rejeitados).push(item);
    });

    if (i + BATCH < candidatos.length) await new Promise((r) => setTimeout(r, 800));
  }

  return { confirmados, rejeitados };
}

// ─── Ler Excel do buffer ──────────────────────────────────────────────────────
function lerExcel(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  return rows.slice(1);
}

// ─── Monta objeto com os campos exatos da coleção Leilões do Wix ─────────────
function montarLeilao(item) {
  const r = item.row;
  const ia = item.ia || {};

  // Data do leilão mais próxima (1ª praça se no futuro, senão 2ª)
  const hoje = new Date();
  const parseData = (str) => {
    if (!str) return null;
    const d = new Date(String(str).split(",")[0].split("/").reverse().join("-"));
    return isNaN(d.getTime()) ? null : d;
  };
  const d1 = parseData(r[COL.data1]);
  const d2 = parseData(r[COL.data2]);
  const dataleilao = (d1 && d1 >= hoje) ? d1 : (d2 || d1);

  // Dívidas
  const divIptu  = Number(r[COL.divIptu])  || 0;
  const divCond  = Number(r[COL.divCond])  || 0;
  const debFid   = Number(r[COL.debFid])   || 0;
  const temDebitoIptu    = divIptu > 0;
  const temOutrasDividas = divCond > 0 || debFid > 0;
  const dividaLimpa      = !temDebitoIptu && !temOutrasDividas;

  return {
    // Campos diretos da SPY
    titulo:                              String(r[COL.titulo]    || ""),
    estado:                              String(r[COL.estado]    || ""),
    cidade:                              String(r[COL.cidade]    || ""),
    processo:                            String(r[COL.processo]  || ""),
    link:                                String(r[COL.link]      || ""),
    "1ºLeilãoPreço":                     Number(r[COL.preco1])   || null,
    "2ºLeilãoPreço":                     Number(r[COL.preco2])   || null,
    "1ºLeilãoData":                      String(r[COL.data1]     || ""),
    "2ºLeilãoData":                      String(r[COL.data2]     || ""),
    dataleilao:                          dataleilao ? dataleilao.toISOString() : null,
    areaMq:                              Number(r[COL.area])     || null,
    endereço:                            String(r[COL.endereco]  || ""),
    tipo:                                String(r[COL.tipo]      || ""),
    leiloeiro:                           String(r[COL.leiloeiro] || ""),
    tipoDeBem:                           String(r[COL.tipoBem]   || ""),
    // Avaliação da SPY = avaliação da fração diretamente (sem cálculo)
    valorDeAvaliaçãoJudicialDaFração:    Number(r[COL.avaliacao]) || null,
    valorDoImóvel:                       Number(r[COL.avaliacao]) || null,
    matrícula:                           String(r[COL.matricula] || ""),
    ocupado:                             String(r[COL.ocupado]   || ""),
    descrição:                           String(r[COL.descricao] || "").slice(0, 5000),
    lote:                                String(r[COL.titulo]    || "").slice(0, 100),

    // Campos calculados
    débitoIptu:    temDebitoIptu,
    outrasDívidas: temOutrasDividas,
    dívidaLimpa:   dividaLimpa,

    // Campos preenchidos pela IA
    éUmLeilãoDeFração: ia.eUmLeilaoFracao ?? true,
    fraçãoQtd:         ia.fracaoQtd  || null,
    observações:       ia.observacoes || null,

    // Padrão: oculto até o time de compras revisar e ativar
    visível: false,
  };
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada no Vercel" });
  }

  // Receber URL de download enviada pelo Wix
  let fileBuffer = null;
  try {
    const body = req.body;
    const downloadUrl = body?.downloadUrl;
    if (!downloadUrl) return res.status(400).json({ error: "downloadUrl não informada" });

    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Erro ao baixar arquivo: ${fileResp.status}`);
    const arrayBuf = await fileResp.arrayBuffer();
    fileBuffer = Buffer.from(arrayBuf);
  } catch (e) {
    return res.status(400).json({ error: `Erro ao receber arquivo: ${e.message}` });
  }

  try {
    const rows = lerExcel(fileBuffer);
    const totalEntrada = rows.length;

    const candidatos = fase1Regex(rows);

    const client = new Anthropic({ apiKey });
    const { confirmados, rejeitados } = await fase2IA(candidatos, client);

    const leiloes = confirmados.map(montarLeilao);

    return res.status(200).json({
      ok: true,
      stats: {
        totalEntrada,
        candidatosRegex: candidatos.length,
        confirmadosIA: confirmados.length,
        rejeitadosIA: rejeitados.length,
        descartadosRegex: totalEntrada - candidatos.length,
      },
      leiloes,
    });
  } catch (e) {
    console.error("Erro no pipeline:", e);
    return res.status(500).json({ error: e.message });
  }
}
