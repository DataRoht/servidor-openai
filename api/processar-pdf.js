const axios = require("axios");
const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

module.exports = async (req, res) => {
  console.log("🔁 Início do processamento do PDF");
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ erro: "Use método POST" });
    }

    const { pdfUrl } = req.body;
    if (!pdfUrl) {
      return res.status(400).json({ erro: "pdfUrl ausente no corpo da requisição" });
    }

    const pdfcoKey = process.env.PDFCO_KEY;
    if (!pdfcoKey) {
      return res.status(500).json({ erro: "PDFCO_KEY não configurada" });
    }

    console.log("📤 Enviando para PDF.co...");
    const pdfcoResponse = await axios.post(
      "https://api.pdf.co/v1/pdf/convert/to/png",
      {
        url: pdfUrl,
        pages: "1-",
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

    console.log(`🖼 Total de páginas convertidas: ${imageUrls.length}`);

    const prompt = `
Você é um advogado especialista em análise de matrículas de imóveis. Analise todas as páginas do documento e responda em JSON:

{
  "coProprietarios": "<em>Lista com nome e CPF em HTML</em>",
  "numeroAverbacoes": <número>,
  "analise": "<em>Análise jurídica da matrícula, em HTML</em>"
}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageUrls.map(url => ({
              type: "image_url",
              image_url: { url }
            }))
          ]
        }
      ],
      max_tokens: 1800
    });

    const resultado = completion.choices[0].message.content;
    console.log("✅ Análise finalizada com sucesso");
    res.status(200).json(JSON.parse(resultado));

  } catch (erro) {
    console.error("❌ Erro:", erro);
    res.status(500).json({
      erro: "Erro ao processar PDF",
      detalhes: erro.message || String(erro)
    });
  }
};
