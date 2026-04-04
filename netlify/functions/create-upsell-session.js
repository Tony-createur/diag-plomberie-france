const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const originalSessionId = body.originalSessionId;

    if (!originalSessionId) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "originalSessionId manquant" }),
      };
    }

    const siteUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.APP_BASE_URL ||
      "https://diagplomberiefrance.com";

    const originalSession = await stripe.checkout.sessions.retrieve(originalSessionId);

    const customerEmail =
      originalSession.customer_details?.email ||
      originalSession.customer_email ||
      originalSession.metadata?.email ||
      "";

    const session = await stripe.checkout.sessions.create({
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
                "Traitement prioritaire + conseils complémentaires + réponse enrichie",
            },
            unit_amount: 1900,
          },
          quantity: 1,
        },
      ],

      metadata: {
        type: "upsell_diag_plomberie",
        original_session_id: originalSessionId,
        customer_email: customerEmail || "",
      },

      success_url: `${siteUrl}/merci.html?session_id=${originalSessionId}&upsell=1&upsell_session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/merci.html?session_id=${originalSessionId}&upsell=0`,
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: session.url,
      }),
    };
  } catch (error) {
    console.error("Erreur create-upsell-session:", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: error.message || "Erreur serveur",
      }),
    };
  }
};
