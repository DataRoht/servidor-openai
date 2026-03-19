/**
 * DataRoht — Processador de Leilões SPY
 * Endpoint: POST /api/processar-leiloes
 *
 * Fluxo:
 *  1. Recebe a downloadUrl do arquivo Excel (enviada pelo Wix backend)
 *  2. Responde imediatamente com 200 "processando" (evita timeout do Wix)
 *  3. Processa em background: regex → IA → chama webhook do Wix com os resultados
 *
 * Variáveis de ambiente no Vercel:
 *   ANTHROPIC_API_KEY   — chave da API da Anthropic
 *   WIX_WEBHOOK_URL     — URL do webhook Wix, ex:
 *                         https://www.dataroht.com/_functions/receberLeiloes
 *   WIX_WEBHOOK_SECRET  — segredo compartilhado (dataroht-leiloes-2024)
 */

import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

// ─── Colunas do Excel SPY ────────────────────────────────────────────────────
const COL = {
  titulo: 0, estado: 1, cidade: 2, processo: 3, link: 4,
  preco1: 5, preco2: 6, data1: 7, data2: 8,
  area: 9, endereco: 10, tipo: 11, leiloeiro: 12, tipoBem: 13,
  avaliacao: 14, financiamento: 15, parcelamento: 16, fgts: 17,
  ocupado: 18, matricula: 19, divCond: 20, divIptu: 21, debFid: 22,
  descricao: 23,
};

// ─── Fase 1: Regex ────────────────────────────────────────────────────────────
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

// ─── Fase 2: IA ───────────────────────────────────────────────────────────────
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

// ─── Montar objeto com campos da coleção Leilões ─────────────────────────────
function montarLeilao(item) {
  const r = item.row;
  const ia = item.ia || {};

  const hoje = new Date();
  const parseData = (str) => {
    if (!str) return null;
    const d = new Date(String(str).split(",")[0].split("/").reverse().join("-"));
    return isNaN(d.getTime()) ? null : d;
  };
  const d1 = parseData(r[COL.data1]);
  const d2 = parseData(r[COL.data2]);
  const dataleilao = (d1 && d1 >= hoje) ? d1 : (d2 || d1);

  const divIptu = Number(r[COL.divIptu]) || 0;
  const divCond = Number(r[COL.divCond]) || 0;
  const debFid  = Number(r[COL.debFid])  || 0;
  const temDebitoIptu    = divIptu > 0;
  const temOutrasDividas = divCond > 0 || debFid > 0;

  return {
    titulo:    String(r[COL.titulo]    || ""),
    estado:    String(r[COL.estado]    || ""),
    cidade:    String(r[COL.cidade]    || ""),
    processo:  String(r[COL.processo]  || ""),
    link:      String(r[COL.link]      || ""),
    preco1:    Number(r[COL.preco1])   || null,
    preco2:    Number(r[COL.preco2])   || null,
    data1:     String(r[COL.data1]     || ""),
    data2:     String(r[COL.data2]     || ""),
    dataleilao: dataleilao ? dataleilao.toISOString() : null,
    area:      Number(r[COL.area])     || null,
    endereco:  String(r[COL.endereco]  || ""),
    tipo:      String(r[COL.tipo]      || ""),
    leiloeiro: String(r[COL.leiloeiro] || ""),
    tipoBem:   String(r[COL.tipoBem]   || ""),
    avaliacao: Number(r[COL.avaliacao]) || null,
    matricula: String(r[COL.matricula] || ""),
    ocupado:   String(r[COL.ocupado]   || ""),
    descricao: String(r[COL.descricao] || "").slice(0, 5000),
    lote:      String(r[COL.titulo]    || "").slice(0, 100),
    debitoIptu:    temDebitoIptu,
    outrasDividas: temOutrasDividas,
    dividaLimpa:   !temDebitoIptu && !temOutrasDividas,
    eUmLeilaoFracao: ia.eUmLeilaoFracao ?? true,
    fracaoQtd:       ia.fracaoQtd  || null,
    observacoes:     ia.observacoes || null,
    visivel: false,
  };
}

// ─── Processamento em background ──────────────────────────────────────────────
async function processarBackground(downloadUrl, apiKey, wixWebhookUrl, wixSecret) {
  console.log("🚀 Iniciando processamento em background...");
  try {
    // Baixar o arquivo Excel
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Erro ao baixar arquivo: ${fileResp.status}`);
    const arrayBuf = await fileResp.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuf);

    // Fase 1: regex
    const wb = XLSX.read(fileBuffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }).slice(1);
    const totalEntrada = rows.length;
    console.log(`📊 ${totalEntrada} linhas lidas`);

    const candidatos = fase1Regex(rows);
    console.log(`🔍 ${candidatos.length} candidatos após regex`);

    // Fase 2: IA
    const client = new Anthropic({ apiKey });
    const { confirmados, rejeitados } = await fase2IA(candidatos, client);
    console.log(`🤖 ${confirmados.length} confirmados pela IA`);

    const leiloes = confirmados.map(montarLeilao);

    const stats = {
      totalEntrada,
      candidatosRegex: candidatos.length,
      confirmadosIA: confirmados.length,
      rejeitadosIA: rejeitados.length,
      descartadosRegex: totalEntrada - candidatos.length,
    };

    // Chamar webhook do Wix com os resultados
    console.log(`📤 Enviando ${leiloes.length} leilões para o Wix...`);
    const wixResp = await fetch(wixWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leiloes, stats, secret: wixSecret }),
    });

    if (!wixResp.ok) {
      const erro = await wixResp.text();
      console.error(`❌ Erro no webhook Wix: ${wixResp.status} — ${erro.slice(0, 200)}`);
    } else {
      const resultado = await wixResp.json();
      console.log(`✅ Wix inseriu ${resultado.inseridos} leilões, ${resultado.duplicatas} duplicatas`);
    }

  } catch (e) {
    console.error("❌ Erro no processamento background:", e.message);
    // Tentar notificar o Wix do erro
    try {
      await fetch(wixWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leiloes: [],
          stats: { erro: e.message },
          secret: wixSecret,
        }),
      });
    } catch (_) {}
  }
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada" });

  const wixWebhookUrl = process.env.WIX_WEBHOOK_URL;
  if (!wixWebhookUrl) return res.status(500).json({ error: "WIX_WEBHOOK_URL não configurada" });

  const wixSecret = process.env.WIX_WEBHOOK_SECRET || "dataroht-leiloes-2024";

  const body = req.body;
  const downloadUrl = body?.downloadUrl;
  if (!downloadUrl) return res.status(400).json({ error: "downloadUrl não informada" });

  // Responde imediatamente — evita timeout do Wix
  res.status(200).json({ ok: true, mensagem: "Processamento iniciado em background" });

  // Processa de forma assíncrona após responder
  processarBackground(downloadUrl, apiKey, wixWebhookUrl, wixSecret);
}
