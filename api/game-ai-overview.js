export default async function handler(req, res) {
  // CORS untuk testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  try {
    const { question } = req.body || {};

    if (!question || typeof question !== "string") {
      return res.status(400).json({
        success: false,
        message: "Question wajib diisi."
      });
    }

    // Proteksi utama:
    // AI Overview hanya boleh aktif jika ada frasa "cara main permainan".
    if (!isAllowedGameOverviewQuestion(question)) {
      return res.status(403).json({
        success: false,
        message: "AI Overview hanya aktif untuk pertanyaan yang mengandung 'cara main'."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "GEMINI_API_KEY belum diset di Environment Variables."
      });
    }

    const prompt = buildPrompt(question);

    const geminiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          tools: [
            {
              google_search: {}
            }
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 700
          }
        })
      }
    );

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      console.error("Gemini API error:", JSON.stringify(data, null, 2));

      return res.status(500).json({
        success: false,
        message: "Gemini API error.",
        detail: data
      });
    }

    const answer = extractAnswer(data);
    const sources = extractGroundingSources(data);

    if (!answer) {
      return res.status(500).json({
        success: false,
        message: "Gemini tidak mengembalikan jawaban."
      });
    }

    return res.status(200).json({
      success: true,
      answer: formatAnswerWithSources(answer, sources),
      sources
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error."
    });
  }
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function isAllowedGameOverviewQuestion(question) {
  const text = normalizeText(question);

  // Syarat wajib dari kamu:
  // hanya boleh aktif ketika ada kata/frasa "cara main permainan".
  if (!text.includes("cara main permainan")) {
    return false;
  }

  // Blokir topik sensitif/internal meskipun user menyisipkan frasa tersebut.
  const blockedKeywords = [
    "deposit",
    "depo",
    "wd",
    "withdraw",
    "penarikan",
    "rekening",
    "bank",
    "qris",
    "dana",
    "ovo",
    "gopay",
    "bukti transfer",
    "mutasi",
    "user id",
    "userid",
    "password",
    "akun saya",
    "login akun",
    "bonus saya",
    "klaim saya",
    "validasi",
    "nomor rekening",
    "nama rekening"
  ];

  return !blockedKeywords.some(keyword => {
    return text.includes(normalizeText(keyword));
  });
}

function buildPrompt(question) {
  return `
Anda adalah asisten CS untuk operator livechat.

Aturan wajib:
- Jawab hanya untuk pertanyaan yang berisi "cara main".
- Fokus menjelaskan cara bermain permainan secara umum.
- Jangan membahas deposit, withdraw, rekening, data member, password, validasi akun, bukti transfer, bonus internal, klaim bonus, atau keputusan akun.
- Jangan memberi janji kemenangan.
- Jangan memberi pola pasti menang.
- Jangan menyuruh user terus bermain.
- Jangan gunakan markdown tebal seperti **teks**.
- Jangan gunakan format citation seperti [cite: 1].
- Jangan tulis link sumber di dalam jawaban utama.
- Jawaban harus ringkas tapi rinci. 
- Gunakan bahasa Indonesia yang natural untuk livechat.

Pertanyaan user:
${question}

Format jawaban wajib:
Cara main permainan [nama permainan]:

1. [Penjelasan singkat namun rinci tentang cara bermain permainannya]
2. [Fitur penting, jika ada]
3. [Jenis Bettingan yang ada]
`;
}

function extractAnswer(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim() || ""
  );
}

function extractGroundingSources(data) {
  const chunks =
    data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

  return chunks
    .map(chunk => {
      const web = chunk.web || {};

      return {
        title: web.title || "",
        url: web.uri || ""
      };
    })
    .filter(source => source.url)
    .slice(0, 5);
}

function formatAnswerWithSources(answer, sources) {
  if (!sources.length) {
    return answer;
  }

  const sourceText = sources
    .map((source, index) => {
      return `${index + 1}. ${source.title || source.url}\n${source.url}`;
    })
    .join("\n\n");

  return `${answer}\n\nSumber:\n${sourceText}`;
}
