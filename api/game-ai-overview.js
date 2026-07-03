const FIREBASE_DB_URL = "https://bot-livechat-rampoz-default-rtdb.firebaseio.com";

export default async function handler(req, res) {
  // CORS
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
            maxOutputTokens: 450
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

    const rawAnswer = extractAnswer(data);
    const sources = extractGroundingSources(data);

    if (!rawAnswer) {
      return res.status(500).json({
        success: false,
        message: "Gemini tidak mengembalikan jawaban."
      });
    }

    const finalAnswer = formatAnswerWithSources(rawAnswer, sources);

    let savedKnowledge = null;

    try {
      savedKnowledge = await saveLearnedKnowledge({
        question,
        answer: finalAnswer,
        sources
      });
    } catch (saveError) {
      console.error("Save learned knowledge error:", saveError);
    }

    return res.status(200).json({
      success: true,
      answer: finalAnswer,
      sources,
      saved: Boolean(savedKnowledge),
      savedKnowledgeId: savedKnowledge?.id || null
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error."
    });
  }
}

/*********************************
 * HELPER
 *********************************/
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function isAllowedGameOverviewQuestion(question) {
  const text = normalizeText(question);

  // Syarat utama: wajib ada frasa ini
  if (!text.includes("cara main")) {
    return false;
  }

  // Blokir topik internal
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
- Jawaban harus pendek, maksimal 8 baris.
- Gunakan bahasa Indonesia yang natural untuk livechat.

Pertanyaan user:
${question}

Format jawaban wajib:
Cara main [nama permainan]:

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
    .slice(0, 3);
}

function cleanAIAnswer(answer) {
  return String(answer || "")
    .replace(/\*\*/g, "")
    .replace(/\[cite:\s*[^\]]+\]/gi, "")
    .replace(/\[source:\s*[^\]]+\]/gi, "")
    .replace(/Sumber:\s*[\s\S]*$/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatAnswerWithSources(answer, sources) {
  const cleanAnswer = cleanAIAnswer(answer);

  if (!sources.length) {
    return cleanAnswer;
  }

  const sourceNames = sources
    .map(source => source.title)
    .filter(Boolean)
    .slice(0, 2)
    .join(", ");

  if (!sourceNames) {
    return cleanAnswer;
  }

  return `${cleanAnswer}\n\nReferensi web: ${sourceNames}`;
}

/*********************************
 * FIREBASE LEARNED KNOWLEDGE
 *********************************/
function buildLearnedKeywords(question) {
  const cleanQuestion = normalizeText(question);

  const gameName = cleanQuestion
    .replace("cara main", "")
    .replace("cara bermain permainan", "")
    .replace("cara main", "")
    .replace("cara bermain", "")
    .trim();

  const keywords = [cleanQuestion];

  if (gameName) {
    keywords.push(`cara main ${gameName}`);
    keywords.push(`cara bermain ${gameName}`);
    keywords.push(`cara main ${gameName}`);
    keywords.push(`cara bermain permainan ${gameName}`);
    keywords.push(`permainan ${gameName}`);
    keywords.push(gameName);
  }

  return [...new Set(keywords)].filter(Boolean);
}

function buildLearnedTitle(question) {
  const cleanQuestion = normalizeText(question);

  const gameName = cleanQuestion
    .replace("cara main", "")
    .replace("cara bermain permainan", "")
    .replace("cara main", "")
    .replace("cara bermain", "")
    .trim();

  if (!gameName) {
    return "Cara Main";
  }

  return `Cara Main ${toTitleCase(gameName)}`;
}

function toTitleCase(text) {
  return String(text || "")
    .split(" ")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function buildSemanticText(question, answer) {
  return normalizeText(`${question} ${answer}`)
    .split(" ")
    .filter(word => word.length >= 3)
    .slice(0, 120)
    .join(" ");
}

function buildSafeFirebaseKey(question) {
  const base = normalizeText(question)
    .replace("cara main", "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 60);

  return `ai_cara_main_${base || Date.now()}`;
}

async function saveLearnedKnowledge({ question, answer, sources }) {
  const now = Date.now();
  const key = buildSafeFirebaseKey(question);

  const payload = {
    title: buildLearnedTitle(question),
    keywords: buildLearnedKeywords(question),
    semanticText: buildSemanticText(question, answer),
    answer: cleanAIAnswer(answer),
    detail: "",
    claim: "",
    source: "gemini_grounding",
    question,
    sources: sources || [],
    status: "approved",
    createdAt: now,
    updatedAt: now
  };

  // Pakai PUT supaya pertanyaan sama tidak bikin data dobel terus.
  const response = await fetch(`${FIREBASE_DB_URL}/ai_learned_knowledge/${key}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("Gagal menyimpan learned knowledge: " + text);
  }

  await response.json();

  return {
    id: key,
    ...payload
  };
}
