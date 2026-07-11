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

// Historique de la conversation envoyé à chaque requête
let history = [];

// Image en attente d'envoi : { mimeType, data (base64 pur), dataUrl (pour l'aperçu) }
let pendingImage = null;

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

// Convertit un fichier image en base64 (sans le préfixe data:...;base64,)
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

async function sendMessage(text) {
  const imageForRequest = pendingImage
    ? { mimeType: pendingImage.mimeType, data: pendingImage.data }
    : undefined;
  const imageDataUrl = pendingImage ? pendingImage.dataUrl : undefined;

  addMessage("user", text, imageDataUrl);
  history.push({ role: "user", content: text, image: imageForRequest });

  // On efface l'aperçu une fois le message envoyé
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
