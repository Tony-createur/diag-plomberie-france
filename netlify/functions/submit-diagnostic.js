const Stripe = require("stripe");
const Busboy = require("busboy");
const { Resend } = require("resend");
const cloudinary = require("cloudinary").v2;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// stockage temporaire en mémoire
const usedSessions = new Set();

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  };
}

function getContentType(headers = {}) {
  return headers["content-type"] || headers["Content-Type"] || "";
}

function getBodyBuffer(event) {
  if (!event.body) return Buffer.from("");
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf8");
}

function parseMultipartFields(headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const contentType = getContentType(headers);
    const fields = {};
    const files = [];

    const busboy = Busboy({
      headers: { "content-type": contentType }
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (name, file, info) => {
      const chunks = [];
      const filename =
        typeof info === "object" && info && info.filename
          ? info.filename
          : "fichier";
      const mimeType =
        typeof info === "object" && info && info.mimeType
          ? info.mimeType
          : "application/octet-stream";

      file.on("data", (chunk) => {
        chunks.push(chunk);
      });

      file.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 0) {
          files.push({
            fieldName: name,
            filename,
            mimeType,
            buffer
          });
        }
      });

      file.on("error", reject);
    });

    busboy.on("finish", () => resolve({ fields, files }));
    busboy.on("error", reject);

    busboy.end(bodyBuffer);
  });
}

function buildMultipartBody(fields) {
  const boundary = "----DiagPlomberieBoundary" + Date.now();
  const chunks = [];

  Object.entries(fields).forEach(([key, value]) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${key}"\r\n\r\n${value ?? ""}\r\n`
      )
    );
  });

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat(chunks)
  };
}

function clean(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function getPrioriteLabel(upsell, urgence) {
  if (upsell === "oui") return "PRIORITAIRE";

  const u = String(urgence || "").toLowerCase();

  if (
    u.includes("urgence absolue") ||
    u.includes("très urgent") ||
    u.includes("tres urgent") ||
    u.includes("immédiat") ||
    u.includes("immediat")
  ) {
    return "URGENT";
  }

  if (
    u.includes("urgent") ||
    u.includes("rapide") ||
    u.includes("prioritaire")
  ) {
    return "À TRAITER RAPIDEMENT";
  }

  return "STANDARD";
}

function getPrioriteStyle(priorite) {
  if (priorite === "PRIORITAIRE") {
    return {
      bg: "#ffe5e5",
      border: "#dc2626",
      text: "#991b1b"
    };
  }

  if (priorite === "URGENT") {
    return {
      bg: "#fff4e5",
      border: "#f59e0b",
      text: "#92400e"
    };
  }

  if (priorite === "À TRAITER RAPIDEMENT") {
    return {
      bg: "#fff7ed",
      border: "#fb923c",
      text: "#9a3412"
    };
  }

  return {
    bg: "#e8f4ff",
    border: "#0d6efd",
    text: "#084298"
  };
}

function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const upload = cloudinary.uploader.upload_stream(
      {
        folder: "diag-plomberie-demandes",
        resource_type: "auto",
        ...options
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    upload.end(buffer);
  });
}

function buildMailtoLink(email, nom) {
  const safeRawEmail = clean(email);
  const safeRawNom = clean(nom, "Client");

  if (!safeRawEmail) return "#";

  const subject = encodeURIComponent(
    "Réponse à votre demande Diag Plomberie France"
  );

  const body = encodeURIComponent(
    `Bonjour ${safeRawNom},\n\nMerci pour votre demande.\n\nVoici mon retour :\n\n`
  );

  return `mailto:${safeRawEmail}?subject=${subject}&body=${body}`;
}

function buildTelLink(telephone) {
  const raw = clean(telephone);
  if (!raw) return "";
  return raw.replace(/[^\d+]/g, "");
}

function parseAdminEmails(value) {
  return String(value || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, message: "Méthode non autorisée." });
  }

  try {
    const appBaseUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.APP_BASE_URL ||
      "https://diagplomberiefrance.com";

    const fromEmail = process.env.RESEND_FROM_EMAIL;
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminRecipients = parseAdminEmails(adminEmail);

    if (
      !process.env.CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_KEY ||
      !process.env.CLOUDINARY_API_SECRET
    ) {
      return json(500, {
        ok: false,
        message: "Variables Cloudinary manquantes."
      });
    }

    const bodyBuffer = getBodyBuffer(event);
    const { fields, files } = await parseMultipartFields(event.headers, bodyBuffer);

    const sessionId = clean(fields.session_id);
    const upsell = clean(fields.upsell) === "oui" ? "oui" : "non";
    const upsellSessionId = clean(fields.upsell_session_id);

    if (!sessionId) {
      return json(400, {
        ok: false,
        message: "Lien invalide."
      });
    }

    const stripeSession = await stripe.checkout.sessions.retrieve(sessionId);

    if (!stripeSession || stripeSession.payment_status !== "paid") {
      return json(400, {
        ok: false,
        message: "Paiement non validé."
      });
    }

    if (usedSessions.has(sessionId)) {
      return json(409, {
        ok: false,
        message: "Cette demande a déjà été envoyée."
      });
    }

    const nom = clean(fields.nom);
    const email = clean(fields.email);
    const telephone = clean(fields.telephone, "Non renseigné");
    const ville = clean(fields.ville, "Non renseignée");
    const logement = clean(fields.logement, "Non renseigné");
    const service = clean(fields.service) || "Diagnostic plomberie en ligne";
    const urgence = clean(fields.urgence, "Non précisée");
    const probleme = clean(fields.probleme, "Non renseigné");

    const priorite = getPrioriteLabel(upsell, urgence);
    const prioriteStyle = getPrioriteStyle(priorite);

    const uploadedPhotos = [];
    for (const file of files.slice(0, 3)) {
      const result = await uploadBufferToCloudinary(file.buffer, {
        public_id: `${Date.now()}-${file.fieldName}`
      });

      uploadedPhotos.push({
        fieldName: file.fieldName,
        originalName: file.filename,
        url: result.secure_url
      });
    }

    const photo1 = uploadedPhotos[0]?.url || "";
    const photo2 = uploadedPhotos[1]?.url || "";
    const photo3 = uploadedPhotos[2]?.url || "";

    const forwardedFields = {
      "form-name": "demande-payee",

      objet: `[${priorite}] Nouvelle demande diagnostic - ${nom || "Client sans nom"}`,
      priorite,
      statut_paiement: "PAYÉ",

      session_id: sessionId,
      upsell,
      upsell_session_id: upsellSessionId,

      nom,
      email,
      telephone,
      ville,
      logement,

      service,
      urgence,
      probleme,

      photo_1_url: photo1,
      photo_2_url: photo2,
      photo_3_url: photo3,

      resume: `
PRIORITÉ : ${priorite}
STATUT PAIEMENT : PAYÉ

COORDONNÉES CLIENT
Nom : ${nom}
Email : ${email}
Téléphone : ${telephone}
Ville : ${ville}
Logement : ${logement}

DÉTAILS DE LA DEMANDE
Service : ${service}
Urgence : ${urgence}

PROBLÈME DÉCLARÉ
${probleme}

PHOTOS
Photo 1 : ${photo1 || "Aucune"}
Photo 2 : ${photo2 || "Aucune"}
Photo 3 : ${photo3 || "Aucune"}

RÉFÉRENCES
Session Stripe : ${sessionId}
Upsell : ${upsell}
Session Upsell : ${upsellSessionId || "Aucune"}
      `.trim()
    };

    const multipart = buildMultipartBody(forwardedFields);

    const forwardResponse = await fetch(`${appBaseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": multipart.contentType
      },
      body: multipart.body
    });

    if (!forwardResponse.ok) {
      return json(500, {
        ok: false,
        message: "Erreur envoi formulaire."
      });
    }

    if (!fromEmail || adminRecipients.length === 0) {
      console.error("Variables email manquantes dans submit-diagnostic.", {
        hasFromEmail: Boolean(fromEmail),
        adminRecipientsCount: adminRecipients.length
      });

      return json(500, {
        ok: false,
        message: "Variables email manquantes."
      });
    }

    const safeNom = escapeHtml(nom || "Client");
    const safeEmail = escapeHtml(email || "Non renseigné");
    const safeTelephone = escapeHtml(telephone);
    const safeVille = escapeHtml(ville);
    const safeLogement = escapeHtml(logement);
    const safeService = escapeHtml(service);
    const safeUrgence = escapeHtml(urgence);
    const safeProbleme = nl2br(probleme);
    const safePriorite = escapeHtml(priorite);
    const safeSessionId = escapeHtml(sessionId);
    const safeUpsell = escapeHtml(upsell === "oui" ? "Oui" : "Non");
    const safeUpsellSession = escapeHtml(upsellSessionId || "Aucune");

    const replyMailtoLink = buildMailtoLink(email, nom);
    const telLink = buildTelLink(telephone);
    const rawEmail = clean(email);
    const emailLink = rawEmail ? `mailto:${rawEmail}` : "#";

    const photosHtml =
      uploadedPhotos.length > 0
        ? uploadedPhotos
            .map(
              (photo, index) => `
                <div style="margin-bottom:18px;">
                  <p style="margin:0 0 8px 0;"><strong>Photo ${index + 1} :</strong>
                    <a href="${photo.url}" target="_blank" style="color:#0d6efd;text-decoration:underline;">
                      Ouvrir l’image
                    </a>
                  </p>
                  <a href="${photo.url}" target="_blank">
                    <img src="${photo.url}" alt="Photo client ${index + 1}" style="max-width:100%;border-radius:12px;border:1px solid #dbeafe;">
                  </a>
                </div>
              `
            )
            .join("")
        : `<p style="margin:0;">Aucune photo jointe.</p>`;

    const telephoneHtml = telLink
      ? `<p style="margin:8px 0;"><strong>Téléphone :</strong> <a href="tel:${telLink}" style="color:#0d6efd;text-decoration:underline;">${safeTelephone}</a></p>`
      : `<p style="margin:8px 0;"><strong>Téléphone :</strong> ${safeTelephone}</p>`;

    const replyButtonHtml =
      rawEmail
        ? `
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px;margin-top:28px;text-align:center;">
            <div style="font-size:16px;font-weight:800;color:#0b3b75;margin-bottom:12px;">
              Actions rapides
            </div>

            <p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">
              <strong>Email direct :</strong>
              <a href="${emailLink}" style="color:#0d6efd;text-decoration:underline;word-break:break-all;">
                ${safeEmail}
              </a>
            </p>

            <p style="margin:0 0 16px 0;">
              <a href="${replyMailtoLink}" style="color:#0d6efd;text-decoration:underline;font-weight:700;">
                Répondre maintenant
              </a>
            </p>

            <a href="${replyMailtoLink}"
               style="background:#0d6efd;color:#ffffff !important;padding:14px 24px;border-radius:12px;text-decoration:none;font-weight:800;display:inline-block;">
               👉 Répondre au client
            </a>

            <p style="margin:14px 0 0 0;font-size:13px;color:#6b7280;">
              Si le bouton ne fonctionne pas dans votre messagerie, cliquez sur l’adresse email ci-dessus
              ou utilisez le bouton “Répondre” de votre boîte mail.
            </p>
          </div>
        `
        : `
          <div style="text-align:center;margin-top:28px;color:#6b7280;font-size:14px;">
            Email client non renseigné
          </div>
        `;

    const htmlAdmin = `
      <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;">
        <div style="max-width:760px;margin:0 auto;padding:24px;">

          <div style="background:#b91c1c;color:#fff;padding:16px 20px;border-radius:16px 16px 0 0;">
            <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;">
              DEMANDE CLIENT COMPLÈTE
            </div>
            <div style="font-size:30px;font-weight:800;line-height:1.15;margin-top:6px;">
              🚨 Nouvelle demande diagnostic
            </div>
          </div>

          <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:22px;">

            <div style="background:${prioriteStyle.bg};border-left:7px solid ${prioriteStyle.border};padding:18px;border-radius:12px;margin-bottom:18px;">
              <div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${prioriteStyle.text};">
                PRIORITÉ
              </div>
              <div style="font-size:22px;font-weight:800;color:${prioriteStyle.text};margin-top:6px;">
                ${safePriorite}
              </div>
            </div>

            <div style="background:#111827;color:#fff;padding:14px;border-radius:10px;margin-bottom:18px;text-align:center;font-weight:800;">
              ⚡ DEMANDE FINALE REÇUE APRÈS FORMULAIRE
            </div>

            <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
              <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                Coordonnées client
              </div>
              <p style="margin:8px 0;"><strong>Nom :</strong> ${safeNom}</p>
              <p style="margin:8px 0;"><strong>Email :</strong> <a href="${emailLink}" style="color:#0d6efd;text-decoration:underline;word-break:break-all;">${safeEmail}</a></p>
              ${telephoneHtml}
              <p style="margin:8px 0;"><strong>Ville :</strong> ${safeVille}</p>
              <p style="margin:8px 0;"><strong>Logement :</strong> ${safeLogement}</p>
            </div>

            <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
              <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                Détails de la demande
              </div>
              <p style="margin:8px 0;"><strong>Service :</strong> ${safeService}</p>
              <p style="margin:8px 0;"><strong>Urgence :</strong> ${safeUrgence}</p>
              <p style="margin:8px 0;"><strong>Statut paiement :</strong> PAYÉ</p>
              <p style="margin:8px 0;"><strong>Upsell :</strong> ${safeUpsell}</p>
            </div>

            <div style="background:#e8f4ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px;margin-bottom:18px;">
              <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#0b3b75;">
                Problème déclaré
              </div>
              <div style="font-size:15px;line-height:1.7;color:#111827;">
                ${safeProbleme}
              </div>
            </div>

            <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:18px;">
              <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                Photos jointes
              </div>
              ${photosHtml}
            </div>

            <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin-bottom:22px;">
              <div style="font-size:16px;font-weight:800;margin-bottom:14px;color:#111827;">
                Références
              </div>
              <p style="margin:8px 0;"><strong>Session Stripe :</strong> ${safeSessionId}</p>
              <p style="margin:8px 0;"><strong>Session Upsell :</strong> ${safeUpsellSession}</p>
            </div>

            ${replyButtonHtml}
          </div>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: fromEmail,
      to: adminRecipients,
      subject: `🚨 ${priorite} - DEMANDE CLIENT COMPLÈTE - ${nom || "Client"} - ${urgence}`,
      html: htmlAdmin,
      replyTo: email || undefined
    });

    usedSessions.add(sessionId);

    return json(200, {
      ok: true,
      redirect: "/demande-envoyee.html"
    });
  } catch (error) {
    console.error("Erreur submit-diagnostic :", error);

    return json(500, {
      ok: false,
      message: "Erreur serveur."
    });
  }
};
