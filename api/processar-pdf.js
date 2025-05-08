const axios = require('axios');
const OpenAI = require('openai');

module.exports = async (req, res) => {
  console.log("📥 Função processar-pdf (PDF.co + OpenAI) foi chamada!");
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ erro: "Use método POST" });
    }

    const { pdfUrl } = req.body;
    if (!pdfUrl) {
      return res.status(400).json({ erro: "pdfUrl ausente no corpo da requisição" });
    }

    const pdfcoKey = process.env.PDFCO_KEY;
    const openaiKey = process.env.OPENAI_KEY;
    if (!pdfcoKey || !openaiKey) {
      return res.status(500).json({ erro: "Chaves OPENAI_KEY ou PDFCO_KEY não configuradas" });
    }

    // 1. Converter PDF inteiro para imagens via PDF.co
    console.log("📤 Enviando PDF para PDF.co...");
    const pdfcoResponse = await axios.post(
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
        }
      }
    );

    const imageUrls = pdfcoResponse.data.urls;
    if (!imageUrls || imageUrls.length === 0) {
      throw new Error("Nenhuma imagem foi gerada pelo PDF.co.");
    }
    console.log(`✅ ${imageUrls.length} página(s) convertida(s) para imagem.`);

    // 2. Enviar cada imagem para o Wix e coletar URLs públicas
    const wixUploads = await Promise.all(imageUrls.map(async (imgUrl, index) => {
      const imageResponse = await axios.get(imgUrl, { responseType: "arraybuffer" });
      const base64 = Buffer.from(imageResponse.data).toString("base64");

      const uploadResponse = await axios.post(
        "https://www.limpaimovel.com.br/_functions/salvarImagemBase64",
        JSON.stringify({
          nomeArquivo: `matricula_page_${index + 1}.png`,
          base64: `data:image/png;base64,${base64}`
        }),
        {
          headers: {
            "Authorization": "Bearer rafa-wix-upload-2025",
            "Content-Type": "application/json"  // 👈 ESSENCIAL
          }
        }
      );

      return uploadResponse.data;
    }));

    console.log("✅ Todas as imagens salvas no Wix com URLs públicas.");

    // 3. Montar o prompt jurídico
    const prompt = `
Você é um especialista jurídico em leilões judiciais de imóveis. A partir da matrícula (convertida em imagens), diga:

1. Quem são os co-proprietários atuais e seus CPFs?
2. Quantas averbações existem?
3. Faça uma análise técnica da matrícula com parecer profissional.

Responda neste formato JSON:
{
  "coProprietarios": "<em>Lista formatada em HTML</em>",
  "numeroAverbacoes": <número>,
  "analise": "<em>Texto formatado em HTML com a análise</em>"
}
Se não souber alguma informação, use null. Nunca quebre o formato JSON.
`;

    // 4. Enviar para o GPT-4 Vision
    const openai = new OpenAI({ apiKey: openaiKey });

    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...wixUploads.map(url => ({
              type: "image_url",
              image_url: { url }
            }))
          ]
        }
      ],
      max_tokens: 1500
    });

    const resultado = completion.choices[0].message.content;
    res.status(200).json({ analise: resultado });

  } catch (error) {
    console.error("❌ Erro completo:", error);
    res.status(500).json({
      erro: "Erro interno ao processar o PDF",
      detalhes: error.message || String(error)
    });
  }
};
