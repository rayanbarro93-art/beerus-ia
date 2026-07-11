const chat = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const orb = document.getElementById("orb");
const status = document.getElementById("status");
const photoBtn = document.getElementById("photoBtn");
const fileInput = document.getElementById("fileInput");
const imagePreview = document.getElementById("imagePreview");
const previewImg = document.getElementById("previewImg");
const removeImageBtn = document.getElementById("removeImage");
const docBtn = document.getElementById("docBtn");
const docInput = document.getElementById("docInput");
const docPreview = document.getElementById("docPreview");
const docName = document.getElementById("docName");
const removeDocBtn = document.getElementById("removeDoc");

// Historique de la conversation envoyé à chaque requête
let history = [];

// Image en attente d'envoi (jointe au prochain message uniquement)
let pendingImage = null; // { mimeType, data (base64 pur), dataUrl }

// Document actif : une fois indexé, reste "attaché" à la conversation
// jusqu'à ce qu'on clique sur "retirer" (permet de poser plusieurs
// questions de suite sur le même PDF).
let activeDocument = null; // { id, fileName, chunkCount }

function addMessage(role, text, imageDataUrl) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "bot"}`;

  if (imageDataUrl) {
    const img = document.createElement("img");
    img.src = imageDataUrl;
    div.appendChild(img);
  }

  if (text) {
    const p = document.createElement("p");
    p.textContent = text;
    div.appendChild(p);
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "msg bot typing";
  div.id = "typing-indicator";
  div.innerHTML = "<span></span><span></span><span></span>";
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById("typing-indicator");
  if (el) el.remove();
}

// Convertit un fichier en base64 (sans le préfixe data:...;base64,)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve({ dataUrl, base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Photo ──────────────────────────────────────────────
photoBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;

  const { dataUrl, base64 } = await fileToBase64(file);
  pendingImage = { mimeType: file.type, data: base64, dataUrl };

  previewImg.src = dataUrl;
  imagePreview.hidden = false;
});

removeImageBtn.addEventListener("click", () => {
  pendingImage = null;
  fileInput.value = "";
  imagePreview.hidden = true;
});

// ── Document (RAG) ─────────────────────────────────────
docBtn.addEventListener("click", () => docInput.click());

docInput.addEventListener("change", async () => {
  const file = docInput.files[0];
  if (!file) return;

  const { base64 } = await fileToBase64(file);

  // Affiche un état "en cours d'indexation" pendant l'appel serveur
  docName.textContent = `Indexation de ${file.name}...`;
  docPreview.hidden = false;
  orb.classList.add("thinking");
  status.textContent = "indexe le document...";

  try {
    const res = await fetch("/api/upload-document", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: base64, fileName: file.name }),
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || "Erreur d'indexation");
    }

    activeDocument = {
      id: result.documentId,
      fileName: result.fileName,
      chunkCount: result.chunkCount,
    };
    docName.textContent = `${result.fileName} (${result.chunkCount} passages indexés)`;

    addMessage(
      "bot",
      `J'ai absorbé le contenu de "${result.fileName}". Interroge-moi dessus, mortel.`
    );
  } catch (err) {
    console.error(err);
    docPreview.hidden = true;
    addMessage("bot", `Impossible de lire ce document : ${err.message}`);
  } finally {
    docInput.value = "";
    orb.classList.remove("thinking");
    status.textContent = "en sommeil";
  }
});

removeDocBtn.addEventListener("click", () => {
  activeDocument = null;
  docInput.value = "";
  docPreview.hidden = true;
});

// ── Envoi de message ───────────────────────────────────
async function sendMessage(text) {
  const imageForRequest = pendingImage
    ? { mimeType: pendingImage.mimeType, data: pendingImage.data }
    : undefined;
  const imageDataUrl = pendingImage ? pendingImage.dataUrl : undefined;

  addMessage("user", text, imageDataUrl);
  history.push({
    role: "user",
    content: text,
    image: imageForRequest,
    documentId: activeDocument ? activeDocument.id : undefined,
  });

  // L'image ne reste jointe qu'un seul message ; le document, lui,
  // reste actif tant que l'utilisateur ne le retire pas.
  pendingImage = null;
  fileInput.value = "";
  imagePreview.hidden = true;

  orb.classList.add("thinking");
  status.textContent = "réfléchit...";
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    if (!res.ok) throw new Error("Réponse serveur invalide");

    const data = await res.json();
    hideTyping();
    addMessage("bot", data.reply);
    history.push({ role: "assistant", content: data.reply });
  } catch (err) {
    hideTyping();
    addMessage("bot", "Beerus est submergé de requêtes en ce moment (ça arrive avec le modèle gratuit). Réessaie dans quelques secondes.");
    console.error(err);
  } finally {
    orb.classList.remove("thinking");
    status.textContent = "en sommeil";
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && !pendingImage) return;
  input.value = "";
  sendMessage(text);
});
