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

    const plainAdmin = `Bonjour,

Nouvelle demande client reçue via Diag Plomberie France.

Nom : ${nom}
Email : ${email}
Téléphone : ${telephone}
Ville : ${ville}
Logement : ${logement}

Service : ${service}
Urgence : ${urgence}
Priorité : ${priorite}
Upsell : ${upsell === "oui" ? "Oui" : "Non"}

Problème :
${probleme}

Photos :
${photo1 || "Aucune"}
${photo2 || ""}
${photo3 || ""}

Session Stripe : ${sessionId}
Session Upsell : ${upsellSessionId || "Aucune"}

--
Diag Plomberie France`;

    const htmlAdmin = `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.6;color:#111;">${escapeHtml(plainAdmin)}</pre>`;

    await resend.emails.send({
      from: fromEmail,
      to: adminRecipients,
      subject: `Nouvelle demande diagnostic - ${nom || "Client"} - ${urgence}`,
      html: htmlAdmin,
      text: plainAdmin,
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
