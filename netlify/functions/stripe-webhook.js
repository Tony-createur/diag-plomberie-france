const Stripe = require("stripe");
const { Resend } = require("resend");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  const signature =
    event.headers["stripe-signature"] || event.headers["Stripe-Signature"];

  let stripeEvent;

  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Erreur signature Stripe :", err.message);
    return {
      statusCode: 400,
      body: `Webhook Error: ${err.message}`,
    };
  }

  try {
    if (stripeEvent.type === "checkout.session.completed") {
      const session = stripeEvent.data.object;

      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["line_items.data.price.product"],
      });

      const customerEmail =
        fullSession.customer_details?.email ||
        session.customer_details?.email ||
        session.customer_email;

      console.log("SESSION :", session);
      console.log("CUSTOMER EMAIL :", customerEmail);

      const lineItem = fullSession.line_items?.data?.[0];
      const productName = lineItem?.price?.product?.name || "";

      const baseUrl =
        process.env.APP_BASE_URL || "https://diagplomberiefrance.com";

      if (!customerEmail) {
        console.log("Aucun email client trouvé pour la session :", session.id);
        return {
          statusCode: 200,
          body: JSON.stringify({ received: true, warning: "No customer email" }),
        };
      }

      let subject = "Paiement reçu – envoyez maintenant votre demande plomberie";
      let html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;">
          <h2>Bonjour,</h2>
          <p>Votre paiement a bien été reçu ✅</p>
          <p>Merci pour votre confiance.</p>
          <p>Dernière étape : cliquez sur le lien ci-dessous pour envoyer votre demande.</p>
          <p>
            <a href="${baseUrl}/merci.html" style="display:inline-block;padding:12px 18px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
              Envoyer ma demande
            </a>
          </p>
          <p>Préparez si possible :</p>
          <ul>
            <li>une description claire du problème</li>
            <li>depuis quand le problème a commencé</li>
            <li>ce que vous avez déjà constaté ou testé</li>
            <li>des photos ou vidéos si possible</li>
          </ul>
          <p><strong>Rappel de votre niveau de traitement :</strong></p>
          <ul>
            <li>Standard : réponse sous 24h</li>
            <li>Express : réponse en quelques heures</li>
            <li>Urgence : traitement prioritaire</li>
          </ul>
          <p>À très vite,</p>
          <p><strong>Diag Plomberie France</strong><br/>contact@diagplomberiefrance.com</p>
        </div>
      `;

      if (productName.toLowerCase().includes("whatsapp")) {
        subject = "Paiement reçu – accès WhatsApp prioritaire activé";
        html = `
          <div style="font-family:Arial,sans-serif;line-height:1.6;color:#222;">
            <h2>Bonjour,</h2>
            <p>Votre paiement a bien été validé ✅</p>
            <p>Votre accès prioritaire WhatsApp est maintenant activé.</p>
            <p>Pour aller au plus vite, cliquez ci-dessous :</p>
            <p>
              <a href="${baseUrl}/merci-urgence.html" style="display:inline-block;padding:12px 18px;background:#25d366;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">
                Accéder à mon urgence WhatsApp
              </a>
            </p>
            <p>Préparez si possible :</p>
            <ul>
              <li>le problème rencontré</li>
              <li>depuis quand il a commencé</li>
              <li>une photo ou une vidéo</li>
            </ul>
            <p>À tout de suite,</p>
            <p><strong>Diag Plomberie France</strong><br/>contact@diagplomberiefrance.com</p>
          </div>
        `;
      }

      console.log("EMAIL EN COURS D'ENVOI À :", customerEmail);

      const emailResult = await resend.emails.send({
        from: "Diag Plomberie France <contact@diagplomberiefrance.com>",
        to: customerEmail,
        subject,
        html,
      });

      console.log("RÉSULTAT RESEND :", emailResult);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true }),
    };
  } catch (error) {
    console.error("Erreur webhook :", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Erreur interne webhook",
        details: error.message,
      }),
    };
  }
};
