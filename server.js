// Serveur backend de Beerus IA
// Rôle : recevoir les messages du frontend, appeler l'API Gemini (Google)
// avec la personnalité de Beerus, et renvoyer la réponse.
// Contient aussi le pipeline RAG (Retrieval-Augmented Generation) qui
// permet à Beerus de répondre à des questions sur un PDF envoyé.

require("dotenv").config();
const express = require("express");
const path = require("path");
const pdfParse = require("pdf-parse");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const EMBEDDING_MODEL = "gemini-embedding-001";

app.use(express.json({ limit: "15mb" })); // pour accepter les images en base64
app.use(express.static(path.join(__dirname, "public")));

// La personnalité de Beerus IA. C'est ici que tu peux le faire évoluer
// avec le temps : ajoute des traits, des règles, des souvenirs, etc.
const SYSTEM_PROMPT = `Tu es Beerus IA, un assistant conversationnel avec la personnalité
d'un dieu de la destruction : puissant, capricieux, un brin arrogant, facilement agacé
par les questions inutiles, mais fondamentalement juste et capable d'une grande sagesse
quand le sujet le mérite. Tu adores la bonne nourriture et tu le fais savoir à l'occasion.
Tu vouvoies rarement, tu es direct, un peu théâtral, mais tu restes toujours utile et tu
donnes de vraies réponses complètes derrière ta grandiloquence. Ne romps jamais ce
personnage. Réponds en français sauf si on te parle dans une autre langue.
Tu as aussi le pouvoir de voir : si un mortel t'envoie une image, tu peux l'observer et
l'analyser avec précision (par exemple identifier ce qu'elle contient, dans quelle
catégorie de déchet un objet doit être trié, ou tout autre détail visuel demandé),
tout en gardant ton ton théâtral et un brin condescendant.
Tu as enfin le pouvoir de lire : quand des passages d'un document te sont fournis dans
le message (précédés de "[Passages pertinents...]"), utilise-les en priorité pour
répondre à la question, comme si ce savoir rejoignait instantanément ta mémoire divine.
Si les passages fournis ne permettent pas de répondre, dis-le clairement plutôt que
d'inventer une réponse.`;

// ───────────────────────────────────────────────────────────
// Pipeline RAG : stockage en mémoire des documents indexés
// (id -> { fileName, chunks: [...texte], vectors: [...nombres] })
// ⚠️ En mémoire uniquement : réinitialisé si le serveur redémarre
// ou se met en veille (plan gratuit Render). Suffisant pour un
// projet perso ; pour une vraie appli il faudrait une vraie base
// de données vectorielle.
// ───────────────────────────────────────────────────────────
const documentStore = {};

// Découpe un long texte en morceaux ("chunks") avec un léger
// chevauchement, pour ne jamais couper une idée en plein milieu.
function chunkText(text, chunkSizeWords = 220, overlapWords = 40) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSizeWords).join(" ");
    if (chunk.trim()) chunks.push(chunk);
    i += chunkSizeWords - overlapWords;
  }
  return chunks;
}

// Similarité cosinus entre deux vecteurs : mesure à quel point
// deux passages de texte "parlent de la même chose" (proche de 1
// = très similaire, proche de 0 = pas de rapport).
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Appelle l'API d'embeddings de Gemini pour convertir plusieurs
// textes en vecteurs numériques, en une seule requête groupée.
async function embedTexts(texts, taskType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${API_KEY}`;

  const requests = texts.map((text) => ({
    model: `models/${EMBEDDING_MODEL}`,
    content: { parts: [{ text }] },
    task_type: taskType, // "RETRIEVAL_DOCUMENT" pour les passages, "RETRIEVAL_QUERY" pour la question
  }));

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur d'embedding: ${errText}`);
  }

  const data = await response.json();
  return data.embeddings.map((e) => e.values);
}

async function embedOne(text, taskType) {
  const [vector] = await embedTexts([text], taskType);
  return vector;
}

// Route : indexation d'un document PDF.
// Extrait le texte, le découpe, calcule les embeddings, et stocke
// le tout en mémoire sous un identifiant renvoyé au frontend.
app.post("/api/upload-document", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "Clé API manquante." });
  }

  const { data, fileName } = req.body;
  if (!data) {
    return res.status(400).json({ error: "Aucun document reçu." });
  }

  try {
    const buffer = Buffer.from(data, "base64");
    const parsed = await pdfParse(buffer);
    const text = parsed.text;

    if (!text || text.trim().length < 20) {
      return res.status(400).json({
        error: "Impossible d'extraire du texte de ce PDF (peut-être un PDF scanné/image).",
      });
    }

    const chunks = chunkText(text);
    const vectors = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");

    const documentId = `doc_${Date.now()}`;
    documentStore[documentId] = { fileName, chunks, vectors };

    res.json({ documentId, fileName, chunkCount: chunks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'indexation du document." });
  }
});

// Convertit l'historique au format attendu par l'API Gemini
// (rôles "user" / "model", texte + éventuellement une image).
// Si un message référence un documentId, on va chercher les
// passages les plus pertinents du document avant de construire
// le texte envoyé au modèle (c'est le cœur du RAG).
async function toGeminiContents(messages) {
  const contents = [];

  for (const m of messages) {
    const parts = [];
    let textForModel = m.content || "";

    if (m.documentId && documentStore[m.documentId] && m.content) {
      const doc = documentStore[m.documentId];
      const queryVector = await embedOne(m.content, "RETRIEVAL_QUERY");

      const scored = doc.chunks.map((chunk, i) => ({
        chunk,
        score: cosineSimilarity(queryVector, doc.vectors[i]),
      }));
      scored.sort((a, b) => b.score - a.score);
      const topChunks = scored.slice(0, 4).map((s) => s.chunk);

      textForModel =
        `[Passages pertinents extraits du document "${doc.fileName}"]:\n` +
        topChunks.join("\n---\n") +
        `\n\n[Question du mortel]: ${m.content}`;
    }

    if (textForModel) {
      parts.push({ text: textForModel });
    }

    if (m.image && m.image.data && m.image.mimeType) {
      parts.push({
        inline_data: {
          mime_type: m.image.mimeType,
          data: m.image.data,
        },
      });
    }

    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return contents;
}

// Petite pause utilitaire (en millisecondes)
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Appelle l'API Gemini avec réessai automatique en cas de surcharge (503)
// ou de trop de requêtes (429). Réessaie jusqu'à `maxRetries` fois,
// en attendant un peu plus longtemps à chaque tentative.
async function callGeminiWithRetry(url, body, maxRetries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return response;
    }

    const errText = await response.text();
    lastError = errText;

    const isOverloaded = response.status === 503 || response.status === 429;
    const hasRetriesLeft = attempt < maxRetries;

    if (isOverloaded && hasRetriesLeft) {
      const delay = 1000 * (attempt + 1); // 1s, puis 2s...
      console.warn(
        `Gemini surchargé (tentative ${attempt + 1}/${maxRetries + 1}), nouvel essai dans ${delay}ms...`
      );
      await wait(delay);
      continue;
    }

    console.error("Erreur API Gemini:", errText);
    return null;
  }

  console.error("Erreur API Gemini après réessais:", lastError);
  return null;
}

app.post("/api/chat", async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: "Clé API manquante. Configure GEMINI_API_KEY dans le fichier .env",
    });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Aucun message reçu." });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const contents = await toGeminiContents(messages);

    const response = await callGeminiWithRetry(url, {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
    });

    if (!response) {
      return res.status(502).json({
        error: "Beerus est surchargé de demandes en ce moment, réessaie dans quelques instants.",
      });
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .join("\n") || "...";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur interne." });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ Beerus IA écoute sur http://localhost:${PORT}`);
});
