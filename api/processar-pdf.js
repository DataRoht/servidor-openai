const axios = require('axios');
const OpenAI = require('openai');

module.exports = async (req, res) => {
  console.log("📥 Função processar-pdf simplificada foi chamada!");
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

    // 1. Converter PDF em imagens (todas as páginas)
    console.log("📤 Enviando PDF para PDF.co...");
    const pdfcoResponse = await axios.post(
      "https://api.pdf.co/v1/pdf/convert/to/png",
      {
        url: pdfUrl,
        pages: "1-", // Todas as páginas
        async: false
      },
      {
        headers: {
          "x-api-key": pdfcoKey,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("📦 Resposta PDF.co:", pdfcoResponse.data);

    const imageUrls = pdfcoResponse.data.urls;
    if (!imageUrls || imageUrls.length === 0) {
      throw new Error("Nenhuma imagem foi gerada pelo PDF.co.");
    }
    console.log(`✅ ${imageUrls.length} página(s) convertida(s). URLs:`, imageUrls);

    // 2. Montar o prompt
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
Se não souber alguma informação, use null. Nunca quebre o formato JSON.`;

    // 3. Enviar para OpenAI Vision
    const openai = new OpenAI({ apiKey: openaiKey });

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
      max_tokens: 1500
    });

    const resultado = completion.choices[0].message.content;
    console.log("✅ Resultado recebido da OpenAI");
    res.status(200).json({ analise: resultado });

  } catch (error) {
    console.error("❌ Erro geral:", error);
    res.status(500).json({ erro: "Erro ao processar PDF", detalhes: error.message });
  }
};

