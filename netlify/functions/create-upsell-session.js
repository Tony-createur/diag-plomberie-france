const Stripe = require("stripe");

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

function clean(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Méthode non autorisée." });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const originalSessionId = clean(body.originalSessionId);

    if (!originalSessionId) {
      return json(400, { error: "originalSessionId manquant" });
    }

    const siteUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.APP_BASE_URL ||
      "https://diagplomberiefrance.com";

    const originalSession = await stripe.checkout.sessions.retrieve(originalSessionId);

    if (!originalSession) {
      return json(404, { error: "Session d’origine introuvable." });
    }

    const customerEmail = clean(
      originalSession.customer_details?.email ||
      originalSession.customer_email ||
      originalSession.metadata?.email ||
      ""
    );

    const upsellSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: customerEmail || undefined,

      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: "Option Prioritaire Diag Plomberie",
              description:
                "Traitement prioritaire + conseils complémentaires + réponse enrichie"
            },
            unit_amount: 999
          },
          quantity: 1
        }
      ],

      metadata: {
        type: "upsell_diag_plomberie",
        original_session_id: originalSessionId,
        customer_email: customerEmail || ""
      },

      success_url: `${siteUrl}/merci.html?session_id=${encodeURIComponent(originalSessionId)}&upsell=1&upsell_session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/merci.html?session_id=${encodeURIComponent(originalSessionId)}&upsell=0`
    });

    if (!upsellSession || !upsellSession.url) {
      return json(500, { error: "Impossible de créer le lien de paiement upsell." });
    }

    return json(200, {
      url: upsellSession.url
    });
  } catch (error) {
    console.error("Erreur create-upsell-session :", error);

    return json(500, {
      error: error.message || "Erreur serveur"
    });
  }
};
