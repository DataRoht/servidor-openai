import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

const app = express();
app.use(express.json({ limit: "50mb" }));

// ─── Health check — Railway usa pra saber se está vivo ───────────────────────
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    servico: "DataRoht Leilões SPY",
    temApiKey: !!process.env.ANTHROPIC_API_KEY,
    temWebhook: !!process.env.WIX_WEBHOOK_URL,
  });
});

// ─── Rota principal ───────────────────────────────────────────────────────────
app.post("/processar-leiloes", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada" });

  const wixWebhookUrl = process.env.WIX_WEBHOOK_URL;
  if (!wixWebhookUrl) return res.status(500).json({ error: "WIX_WEBHOOK_URL não configurada" });

  const wixSecret = process.env.WIX_WEBHOOK_SECRET || "dataroht-leiloes-2024";
  const { downloadUrl, filtros = {} } = req.body;

  if (!downloadUrl) return res.status(400).json({ error: "downloadUrl não informada" });

  // Responde imediatamente — Railway não tem timeout, mas o Wix sim
  res.status(200).json({ ok: true, mensagem: "Processamento iniciado em background" });

  // Processa sem bloquear a resposta
  processarBackground(downloadUrl, filtros, apiKey, wixWebhookUrl, wixSecret)
    .catch(err => console.error("❌ Erro fatal no background:", err.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 DataRoht Leilões SPY rodando na porta ${PORT}`));

// ─── Índices das colunas no Excel SPY ────────────────────────────────────────
const COL = {
  titulo: 0, estado: 1, cidade: 2, processo: 3, link: 4,
  preco1: 5, preco2: 6, data1: 7, data2: 8,
  area: 9, endereco: 10, tipo: 11, leiloeiro: 12, tipoBem: 13,
  avaliacao: 14, financiamento: 15, parcelamento: 16, fgts: 17,
  ocupado: 18, matricula: 19, divCond: 20, divIptu: 21, debFid: 22,
  descricao: 23,
};

// ─── Filtro: só judiciais com processo CNJ ────────────────────────────────────
function filtrarJudiciais(rows) {
  return rows.filter((row) => {
    const tipo = String(row[COL.tipo] || "").toLowerCase().trim();
    const processo = String(row[COL.processo] || "").trim();
    const ehJudicial = tipo.includes("judicial") && !tipo.includes("extra");
    const temProcesso = processo.length > 5;
    return ehJudicial && temProcesso;
  });
}

// ─── Fase 1: Regex — candidatos a fração ─────────────────────────────────────
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

// ─── Fase 2: IA — extrai e enriquece campos ───────────────────────────────────
const SYSTEM_PROMPT = `Você é especialista em leilões judiciais de imóveis no Brasil.

CRITÉRIO — É FRAÇÃO:
Fração = uma PARTE do imóvel sendo leiloada (copropriedade), não o imóvel inteiro.
✓ "50% de um apartamento", "1/3 do imóvel", "fração ideal de 25%", direitos hereditários, meação
✗ Imóvel inteiro, "entrada de 25%", "desconto de 46%", "fração de 337/1.000.000 do terreno" (técnico de matrícula)

Extraia o máximo de informações do título e descrição.
Quando não houver dado explícito: null para textos e números, false para booleanos.

Responda SOMENTE com JSON válido:
{
  "resultados": [
    {
      "id": <número>,
      "eUmLeilaoFracao": true/false,
      "fracaoQtd": "50%" ou "1/3" ou null,
      "matricula": "número da matrícula ou null",
      "cartorioRegistro": "nome do cartório ou null",
      "valorImovel": valor numérico total do imóvel ou null,
      "quantasRestricoes": número inteiro de restrições judiciais ou 0,
      "debitoIptu": true/false,
      "outrasDividas": true/false,
      "dividaLimpa": true/false,
      "observacoes": "resumo objetivo para o time de compras — mencione fração, localização e estado do imóvel"
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
      const desc = String(r[COL.descricao] || "").slice(0, 600);
      return `--- LEILÃO ${i + idx} ---\nTÍTULO: ${r[COL.titulo] || ""}\nDESCRIÇÃO: ${desc}`;
    });

    let parsed;
    try {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Classifique e extraia:\n\n${linhas.join("\n\n")}` }],
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

// ─── Montar objeto com campos da coleção Leilões ──────────────────────────────
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
    ocupado:   String(r[COL.ocupado]   || ""),
    descricao: String(r[COL.descricao] || "").slice(0, 5000),
    lote:      String(r[COL.titulo]    || "").slice(0, 100),
    eUmLeilaoFracao:   ia.eUmLeilaoFracao  ?? true,
    fracaoQtd:         ia.fracaoQtd        || null,
    matricula:         ia.matricula        || String(r[COL.matricula] || "") || null,
    cartorioRegistro:  ia.cartorioRegistro || null,
    valorImovel:       ia.valorImovel      || Number(r[COL.avaliacao]) || null,
    quantasRestricoes: ia.quantasRestricoes ?? 0,
    debitoIptu:        ia.debitoIptu       ?? temDebitoIptu,
    outrasDividas:     ia.outrasDividas    ?? temOutrasDividas,
    dividaLimpa:       ia.dividaLimpa      ?? (!temDebitoIptu && !temOutrasDividas),
    observacoes:       ia.observacoes      || null,
    visivel: false,
  };
}

// ─── Processamento em background ──────────────────────────────────────────────
async function processarBackground(downloadUrl, filtros, apiKey, wixWebhookUrl, wixSecret) {
  console.log("🚀 Iniciando processamento em background...");
  try {
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) throw new Error(`Erro ao baixar arquivo: ${fileResp.status}`);
    const arrayBuf = await fileResp.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuf);

    const wb = XLSX.read(fileBuffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const todasLinhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null }).slice(1);
    console.log(`📊 ${todasLinhas.length} linhas lidas`);

    const judiciais = filtros?.apenasJudicial !== false ? filtrarJudiciais(todasLinhas) : todasLinhas;
    console.log(`⚖️ ${judiciais.length} judiciais com processo CNJ`);

    const candidatos = fase1Regex(judiciais);
    console.log(`🔍 ${candidatos.length} candidatos após regex`);

    if (candidatos.length === 0) {
      await fetch(wixWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leiloes: [],
          stats: { totalEntrada: todasLinhas.length, judiciais: judiciais.length, candidatosRegex: 0, confirmadosIA: 0 },
          secret: wixSecret,
        }),
      });
      return;
    }

    const client = new Anthropic({ apiKey });
    const { confirmados, rejeitados } = await fase2IA(candidatos, client);
    console.log(`🤖 ${confirmados.length} confirmados, ${rejeitados.length} rejeitados`);

    const leiloes = confirmados.map(montarLeilao);
    const stats = {
      totalEntrada: todasLinhas.length,
      judiciais: judiciais.length,
      candidatosRegex: candidatos.length,
      confirmadosIA: confirmados.length,
      rejeitadosIA: rejeitados.length,
    };

    console.log(`📤 Enviando ${leiloes.length} leilões para o Wix...`);
    const wixResp = await fetch(wixWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leiloes, stats, secret: wixSecret }),
    });

    if (!wixResp.ok) {
      console.error(`❌ Erro no webhook Wix: ${wixResp.status}`);
    } else {
      const resultado = await wixResp.json();
      console.log(`✅ Wix inseriu ${resultado.inseridos} leilões, ${resultado.duplicatas} duplicatas`);
    }

  } catch (e) {
    console.error("❌ Erro no processamento background:", e.message);
    try {
      await fetch(wixWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leiloes: [], stats: { erro: e.message }, secret: wixSecret }),
      });
    } catch (_) {}
  }
}
