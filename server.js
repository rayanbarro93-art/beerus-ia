// Serveur backend de Beerus IA
// Rôle : recevoir les messages du frontend, appeler l'API Gemini (Google)
// avec la personnalité de Beerus, et renvoyer la réponse.

require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

app.use(express.json({ limit: "12mb" })); // augmenté pour accepter les images envoyées en base64
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
tout en gardant ton ton théâtral et un brin condescendant.`;

// Convertit l'historique au format attendu par l'API Gemini
// (rôles "user" / "model", texte + éventuellement une image dans "parts")
function toGeminiContents(messages) {
  return messages.map((m) => {
    const parts = [];

    if (m.content) {
      parts.push({ text: m.content });
    }

    if (m.image && m.image.data && m.image.mimeType) {
      parts.push({
        inline_data: {
          mime_type: m.image.mimeType,
          data: m.image.data, // base64 sans le préfixe "data:image/...;base64,"
        },
      });
    }

    return {
      role: m.role === "assistant" ? "model" : "user",
      parts,
    };
  });
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

    // Erreur définitive : on arrête là
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

    const response = await callGeminiWithRetry(url, {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: toGeminiContents(messages),
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
