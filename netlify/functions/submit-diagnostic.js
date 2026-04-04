const Stripe = require("stripe");
const Busboy = require("busboy");
const { getStore } = require("@netlify/blobs");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return reject(new Error("Le formulaire doit être envoyé en multipart/form-data."));
    }

    const fields = {};
    const busboy = Busboy({
      headers: {
        "content-type": contentType
      }
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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, message: "Méthode non autorisée." });
  }

  try {
    const appBaseUrl = process.env.APP_BASE_URL;

    if (!appBaseUrl) {
      return json(500, {
        ok: false,
        message: "APP_BASE_URL manquante."
      });
    }

    const bodyBuffer = getBodyBuffer(event);
    const fields = await parseMultipartFields(event.headers, bodyBuffer);

    const sessionId = fields.session_id;
    const customerEmail = fields.email || "";
    const customerName = fields.nom || "";

    if (!sessionId) {
      return json(400, {
        ok: false,
        message: "Lien invalide : session de paiement introuvable."
      });
    }

    let stripeSession;
    try {
      stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
      console.error("Session Stripe introuvable :", err);
      return json(400, {
        ok: false,
        message: "Session de paiement invalide."
      });
    }

    if (!stripeSession || stripeSession.payment_status !== "paid") {
      return json(400, {
        ok: false,
        message: "Paiement non validé pour cette session."
      });
    }

    const store = getStore("diag-plomberie-sessions");
    const usedKey = `used:${sessionId}`;

    const alreadyUsed = await store.get(usedKey, { type: "json" });

    if (alreadyUsed) {
      return json(409, {
        ok: false,
        message: "Cette demande a déjà été envoyée pour cette commande."
      });
    }

    const forwardResponse = await fetch(`${appBaseUrl}/`, {
      method: "POST",
      headers: {
        "Content-Type": getContentType(event.headers)
      },
      body: bodyBuffer
    });

    if (!forwardResponse.ok) {
      const errorText = await forwardResponse.text().catch(() => "");
      console.error("Erreur Netlify Forms :", errorText);

      return json(500, {
        ok: false,
        message: "Impossible d'enregistrer la demande pour le moment."
      });
    }

    await store.setJSON(usedKey, {
      used: true,
      usedAt: new Date().toISOString(),
      email: customerEmail,
      nom: customerName
    });

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
