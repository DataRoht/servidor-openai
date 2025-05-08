
// teste para forçar deploy
const axios = require('axios');
const { fromBuffer } = require('pdf2pic');
const OpenAI = require('openai');

module.exports = async (req, res) => {
  try {
    const { pdfUrl } = req.body;

    // baixar PDF
    const pdfResponse = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
    const pdfBuffer = Buffer.from(pdfResponse.data);

    // converter PDF → Imagem
    const converter = fromBuffer(pdfBuffer, {
      density: 300,
      format: "png",
      width: 1240,
      height: 1754
    });

    const pageImage = await converter(1, true);
    const base64Image = pageImage.base64;

    // enviar imagem para OpenAI GPT-4 Vision
    const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

    const respostaOpenAI = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extraia coproprietários com CPF, número de averbações e faça uma breve análise jurídica deste imóvel." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } }
          ]
        }
      ],
      max_tokens: 1000
    });

    const analise = respostaOpenAI.choices[0].message.content;

    // resposta
    res.status(200).json({ analise });

  } catch (error) {
    console.error(error);
    res.status(500).json({ erro: error.message });
  }
};