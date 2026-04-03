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
    const data = JSON.parse(event.body || "{}");

    const {
      email,
      nom,
      telephone,
      ville,
      logement,
      urgence,
      probleme,
      service,
      amount
    } = data;

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Email manquant" }),
      };
    }

    const siteUrl =
      process.env.URL ||
      process.env.DEPLOY_PRIME_URL ||
      process.env.APP_BASE_URL ||
      "https://diagplomberiefrance.com";

    const amountInCents = Number(amount) || 2900;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,

      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: service || "Diagnostic plomberie en ligne",
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],

      success_url: `${siteUrl}/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/`,

      metadata: {
        email: email || "",
        nom: nom || "",
        telephone: telephone || "",
        ville: ville || "",
        logement: logement || "",
        urgence: urgence || "",
        probleme: probleme || "",
        service: service || "Diagnostic plomberie en ligne",
      },
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
  } catch (err) {
    console.error("Erreur create-checkout :", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        error: "Erreur serveur",
        details: err.message,
      }),
    };
  }
};
