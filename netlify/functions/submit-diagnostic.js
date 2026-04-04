const Stripe = require("stripe");
const Busboy = require("busboy");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    const busboy = Busboy({
      headers: { "content-type": contentType }
    });

    busboy.on("field", (name, value) => {
      fields[name] = value;
    });

    busboy.on("file", (_name, file) => {
      file.resume();
    });

    busboy.on("finish", () => resolve(fields));
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

    const bodyBuffer = getBodyBuffer(event);
    const fields = await parseMultipartFields(event.headers, bodyBuffer);

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
    const telephone = clean(fields.telephone);
    const ville = clean(fields.ville);
    const logement = clean(fields.logement);
    const service = clean(fields.service) || "Diagnostic plomberie en ligne";
    const urgence = clean(fields.urgence);
    const probleme = clean(fields.probleme);

    const priorite = getPrioriteLabel(upsell, urgence);

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
