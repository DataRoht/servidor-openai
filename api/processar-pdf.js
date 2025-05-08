const axios = require('axios');
const { fromBuffer } = require('pdf2pic');
const OpenAI = require('openai');

module.exports = async (req, res) => {
  console.log("📥 Função processar-pdf foi chamada!");
  console.log("🔁 Redeploy forçado em " + new Date().toISOString());

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ erro: "Use método POST" });
    }

    const { pdfUrl } = req.body;
    console.log("🧾 URL recebida:", pdfUrl);

    if (!pdfUrl) {
      return res.status(400).json({ erro: "pdfUrl ausente no corpo da requisição" });
    }

    const openaiKey = process.env.OPENAI_KEY;
    if (!openaiKey) {
      return res.status(500).json({ erro: "Chave OPENAI_KEY não está configurada" });
    }

    // 1. Baixar PDF da URL
    const pdfResponse = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // 2. Converter PDF para imagem (primeira página)
    const converter = fromBuffer(pdfBuffer, {
      density: 300,
      format: "png",
      width: 1240,
      height: 1754
    });
    console.log("🖼️ Converter inicializado");

    const pageImage = await converter(1, true);
    console.log("✅ Imagem gerada");
    const base64Image = pageImage.base64;

    // 3. Prompt jurídico estruturado
    const prompt = `
Você é um especialista jurídico em leilões judiciais de imóveis. A partir da imagem da matrícula fornecida, diga:

1. Quem são os co-proprietários atuais e seus CPFs?
2. Quantas averbações existem?
3. Faça uma análise técnica da matrícula com parecer profissional.

Retorne neste formato JSON:
{
  "coProprietarios": "<em>Lista formatada em HTML</em>",
  "numeroAverbacoes": <número>,
  "analise": "<em>Texto formatado em HTML com a análise</em>"
}
Se não souber alguma informação, use null. Nunca quebre o formato JSON.
`;

    // 4. Enviar para GPT-4 Vision
    const openai = new OpenAI({ apiKey: openaiKey });

    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
          ]
        }
      ],
      max_tokens: 1000
    });

    const resultado = completion.choices[0].message.content;

    // 5. Retornar texto (Wix irá tentar converter para JSON se possível)
    res.status(200).json({ analise: resultado });
    

  } catch (error) {
    console.error("❌ Erro completo:", error);
    res.status(500).json({
      erro: "Erro interno ao processar o PDF",
      detalhes: error.message || String(error)
    });
  }
};
