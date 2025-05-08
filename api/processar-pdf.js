// Arquivo: /api/processar-pdf.js (em Vercel)

const axios = require('axios');
const OpenAI = require('openai');

module.exports = async (req, res) => {
  console.log("📥 Função processar-pdf foi chamada!");
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ erro: "Use método POST" });
    }

    const { pdfUrl } = req.body;
    if (!pdfUrl) {
      return res.status(400).json({ erro: "pdfUrl ausente" });
    }

    const pdfcoKey = process.env.PDFCO_KEY;
    const openaiKey = process.env.OPENAI_KEY;
    if (!pdfcoKey || !openaiKey) {
      return res.status(500).json({ erro: "Chaves ausentes" });
    }

    // Etapa 1 – Conversão PDF → PNG
    console.log("📤 Enviando PDF para PDF.co...");
    const pdfcoResp = await axios.post(
      "https://api.pdf.co/v1/pdf/convert/to/png",
      {
        url: pdfUrl,
        pages: "1-", // todas as páginas
        async: false
      },
      {
        headers: {
          "x-api-key": pdfcoKey,
          "Content-Type": "application/json"
        },
        timeout: 180000 // 3 minutos
      }
    );

    const imageUrls = pdfcoResp.data.urls;
    if (!imageUrls || imageUrls.length === 0) {
      throw new Error("Nenhuma imagem foi gerada pelo PDF.co.");
    }
    console.log(`✅ ${imageUrls.length} página(s) convertida(s).`);

    // Etapa 2 – Enviar imagens ao GPT-4-Vision
    const openai = new OpenAI({ apiKey: openaiKey });

    const prompt = `Você é um especialista jurídico em leilões judiciais. Analise a matrícula do imóvel a seguir:

1. Liste os co-proprietários e seus respectivos CPFs.
2. Conte o número de averbações.
3. Escreva uma análise técnica jurídica sobre a matrícula.

Formato da resposta:
{
  "coProprietarios": "<p>...HTML...</p>",
  "numeroAverbacoes": 0,
  "analise": "<p>...HTML...</p>"
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageUrls.map(url => ({ type: "image_url", image_url: { url } }))
          ]
        }
      ],
      max_tokens: 1800,
      temperature: 0.2
    });

    const resposta = completion.choices[0].message.content;
    res.status(200).json({ resultado: resposta });

  } catch (err) {
    console.error("❌ Erro completo:", err);
    res.status(500).json({ erro: "Erro ao processar PDF", detalhes: err.message });
  }
};
